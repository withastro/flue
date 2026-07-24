import {
	type ChannelRouteDefinition,
	createChannelRouter,
	type JsonValue as RuntimeJsonValue,
} from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import { InvalidZendeskInputError, InvalidZendeskInstanceIdError } from './errors.ts';
import { createZendeskWebhookHandler } from './webhook.ts';

export { InvalidZendeskInputError, InvalidZendeskInstanceIdError } from './errors.ts';

/** JSON-compatible channel value. Unsafe parsed integers are represented as strings. */
export type JsonValue = RuntimeJsonValue;

/** JSON object used for provider-native Zendesk payload fields. */
export type JsonObject = { [key: string]: JsonValue };

/** Ingress configuration for one Zendesk webhook signing secret. */
export interface ZendeskChannelOptions<E extends Env = Env> {
	/** Signing secret used to verify the timestamp and exact request bytes. */
	signingSecret: string;
	/**
	 * Optional fixed account id for the signed body and matched header metadata.
	 * Mismatches receive `403`.
	 */
	accountId?: string;
	/**
	 * Optional fixed webhook id from provider header metadata. Mismatches
	 * receive `403`; Zendesk's HMAC does not cover this header.
	 */
	webhookId?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified Zendesk event-subscription delivery. */
	webhook(input: ZendeskWebhookHandlerInput<E>): ZendeskHandlerResult;
}

/** Stable account-scoped Zendesk ticket identity. */
export interface ZendeskTicketRef {
	/** Positive decimal Zendesk account id. */
	accountId: string;
	/** Positive decimal ticket id within the account. */
	ticketId: string;
}

/**
 * Provider-native Zendesk event-subscription payload.
 *
 * Field names, nesting, and discriminants match Zendesk's documented common
 * event envelope. The `account_id` integer is preserved losslessly as a
 * positive decimal string rather than a rounded JavaScript number; every other
 * safe numeric literal stays a number and unsafe integers stay decimal strings.
 *
 * Zendesk's event catalog and schema versions remain open, so `type`,
 * `zendesk_event_version`, `detail`, and `event` are deliberately broad.
 * Applications narrow `detail` and `event` for the event families they consume.
 *
 * @see https://developer.zendesk.com/api-reference/webhooks/event-types/webhook-event-types/
 */
export interface ZendeskEvent<
	TDetail extends JsonObject = JsonObject,
	TEvent extends JsonObject = JsonObject,
> {
	/**
	 * Zendesk account id, normalized to a positive decimal string. Checked
	 * against the `X-Zendesk-Account-Id` header for consistency.
	 */
	account_id: string;
	/** Unique provider event id. Use it as a replay-resistant deduplication key. */
	id: string;
	/** Open provider event type, e.g. `zen:event-type:ticket.created`. */
	type: string;
	/** Provider resource subject, e.g. `zen:ticket:<id>`. */
	subject: string;
	/** Provider event occurrence timestamp. */
	time: string;
	/** Open provider schema version, e.g. `2022-06-20`. */
	zendesk_event_version: string;
	/** Provider-native change object. Properties vary by event type. */
	event: TEvent;
	/** Provider-native resource object. Properties vary by event domain. */
	detail: TDetail;
	[key: string]: JsonValue;
}

/**
 * Unsigned provider delivery metadata from request headers.
 *
 * Zendesk's HMAC covers only the signature timestamp and request body, not
 * these headers. They are routing and attempt-correlation metadata, never an
 * authorization capability.
 */
export interface ZendeskDelivery {
	/** Webhook configuration id from `X-Zendesk-Webhook-Id`. */
	webhookId: string;
	/**
	 * Delivery attempt id from `X-Zendesk-Webhook-Invocation-Id`, for correlating
	 * provider retries. Prefer the signed `payload.id` for deduplication.
	 */
	invocationId: string;
	/** Timestamp string included in the verified signature input. */
	signatureTimestamp: string;
}

export interface ZendeskWebhookHandlerInput<E extends Env = Env> {
	/** Authentic Hono context for the discovered route. */
	c: Context<E>;
	/** Verified provider-native Zendesk event-subscription payload. */
	payload: ZendeskEvent;
	/** Unsigned provider delivery metadata from request headers. */
	delivery: ZendeskDelivery;
}

type ZendeskHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or JSON acknowledges with `200`. A returned `Response`
 * passes through. A thrown callback fails closed with retryable `409`.
 */
export type ZendeskHandlerResult = ZendeskHandlerValue | Promise<ZendeskHandlerValue>;

/** Verified Zendesk ingress and canonical ticket identity helpers. */
export interface ZendeskChannel<E extends Env = Env> {
	/** Fixed route declarations published beneath the discovered channel path. */
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/zendesk', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id. It is not an authorization capability. */
	instanceId(ref: ZendeskTicketRef): string;
	/**
	 * Parses only canonical instance ids produced by `instanceId()`. Escape
	 * hatch: agents normally receive structured facts as creation data rather
	 * than parsing them from the id.
	 */
	parseInstanceId(id: string): ZendeskTicketRef;
}

/**
 * Creates one verified Zendesk event-subscription webhook route.
 *
 * The route is fixed at `POST /webhook`. The channel is stateless and does not
 * deduplicate, reorder, or apply an undocumented timestamp freshness window.
 *
 * Zendesk allows 12 seconds for the complete request and retries `409`
 * responses up to three times, so admit durable work promptly (for example
 * `dispatch(...)` then return) and rely on idempotency rather than blocking on
 * slow work before acknowledging.
 */
export function createZendeskChannel<E extends Env = Env>(
	options: ZendeskChannelOptions<E>,
): ZendeskChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createZendeskWebhookHandler(options),
		},
	];
	const channel: ZendeskChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertTicketRef(ref);
			return [
				'zendesk',
				'v1',
				'account',
				encodeURIComponent(ref.accountId),
				'ticket',
				encodeURIComponent(ref.ticketId),
			].join(':');
		},
		parseInstanceId(id) {
			try {
				const match = /^zendesk:v1:account:([^:]+):ticket:([^:]+)$/.exec(id);
				if (!match?.[1] || !match[2]) throw new InvalidZendeskInstanceIdError();
				const ref: ZendeskTicketRef = {
					accountId: decodeURIComponent(match[1]),
					ticketId: decodeURIComponent(match[2]),
				};
				assertTicketRef(ref);
				if (channel.instanceId(ref) !== id) throw new InvalidZendeskInstanceIdError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidZendeskInstanceIdError) throw error;
				throw new InvalidZendeskInstanceIdError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: ZendeskChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createZendeskChannel() requires an options object.');
	}
	if (typeof options.signingSecret !== 'string' || options.signingSecret.length === 0) {
		throw new TypeError('createZendeskChannel() requires a non-empty signingSecret.');
	}
	if (options.accountId !== undefined && !isPositiveDecimal(options.accountId)) {
		throw new TypeError('Zendesk accountId must be a positive decimal string when provided.');
	}
	if (
		options.webhookId !== undefined &&
		(typeof options.webhookId !== 'string' ||
			options.webhookId.length === 0 ||
			options.webhookId.trim() !== options.webhookId)
	) {
		throw new TypeError('Zendesk webhookId must be a non-empty trimmed string when provided.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createZendeskChannel() requires a webhook handler.');
	}
}

function assertTicketRef(ref: ZendeskTicketRef): void {
	if (!ref || typeof ref !== 'object') {
		throw new InvalidZendeskInputError('ticket');
	}
	if (!isPositiveDecimal(ref.accountId)) {
		throw new InvalidZendeskInputError('ticket.accountId');
	}
	if (!isPositiveDecimal(ref.ticketId)) {
		throw new InvalidZendeskInputError('ticket.ticketId');
	}
}

function isPositiveDecimal(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}
