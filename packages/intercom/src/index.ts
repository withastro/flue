import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import { InvalidIntercomInputError, InvalidIntercomInstanceIdError } from './errors.ts';
import { createIntercomValidationHandler, createIntercomWebhookHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';
export { InvalidIntercomInputError, InvalidIntercomInstanceIdError } from './errors.ts';

export type JsonObject = { [key: string]: JsonValue };

/** Ingress configuration for one Intercom developer app secret. */
export interface IntercomChannelOptions<E extends Env = Env> {
	/** Developer app client secret used to verify exact request bytes. */
	clientSecret: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified Intercom topic, including `ping`. */
	webhook(input: IntercomWebhookHandlerInput<E>): IntercomHandlerResult;
}

/** Stable workspace-scoped Intercom conversation identity. */
export interface IntercomConversationRef {
	workspaceId: string;
	conversationId: string;
}

/**
 * Provider-native `data` envelope of a notification.
 *
 * Intercom nests the affected resource under `data.item`; the item's shape is
 * defined by its own `type` field and varies by API version and topic, so it
 * is left as open JSON for the application to validate.
 */
export interface IntercomNotificationData {
	item: JsonValue;
	[key: string]: JsonValue;
}

/**
 * One verified Intercom webhook notification, passed through with Intercom's
 * own field names and nesting.
 *
 * Topic item schemas vary by API version, and some deletion or ticket topics
 * use exceptional wrappers, so applications validate the fields they consume.
 * Unmodeled top-level fields (for example `delivery_status`, `delivered_at`,
 * or `links` on newer topics) are forwarded unchanged via the index signature.
 */
export interface IntercomNotification {
	type: 'notification_event';
	/** Provider topic string, e.g. `conversation.user.replied`. Not a closed union. */
	topic: string;
	/** Workspace identity Intercom supplies as top-level `app_id`. */
	app_id: string;
	/** Notification id for application-owned deduplication. Pings may use null. */
	id: string | null;
	created_at: number;
	delivery_attempts: number;
	first_sent_at: number;
	data: IntercomNotificationData;
	/** Optional provider notification URL. */
	self?: string | null;
	[key: string]: JsonValue | undefined;
}

export interface IntercomWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Provider-native notification payload after exact-byte verification. */
	notification: IntercomNotification;
}

type IntercomHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or JSON acknowledges with `200`. A returned `Response`
 * passes through; use custom statuses only with Intercom retry semantics in
 * mind.
 */
export type IntercomHandlerResult = IntercomHandlerValue | Promise<IntercomHandlerValue>;

/** Verified Intercom ingress and canonical conversation identity helpers. */
export interface IntercomChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/intercom', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id, the canonical identifier. It is not an authorization capability. */
	instanceId(ref: IntercomConversationRef): string;
	/**
	 * Parses only instance ids produced by `instanceId()`. Escape hatch: agents
	 * normally receive structured facts as creation data rather than parsing
	 * them from the id.
	 */
	parseInstanceId(id: string): IntercomConversationRef;
}

/**
 * Creates fixed Intercom endpoint-validation and webhook routes.
 *
 * The channel is stateless and does not deduplicate or reorder notifications.
 * Intercom expects a `2xx` acknowledgement within five seconds and otherwise
 * retries the notification once after a minute, so applications should admit
 * durable work quickly and rely on `id` for idempotency rather than blocking
 * the callback on slow operations.
 */
export function createIntercomChannel<E extends Env = Env>(
	options: IntercomChannelOptions<E>,
): IntercomChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'HEAD',
			path: '/webhook',
			handler: createIntercomValidationHandler(),
		},
		{
			method: 'POST',
			path: '/webhook',
			handler: createIntercomWebhookHandler(options),
		},
	];
	const channel: IntercomChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertConversationRef(ref);
			return [
				'intercom',
				'v1',
				'workspace',
				encodeURIComponent(ref.workspaceId),
				'conversation',
				encodeURIComponent(ref.conversationId),
			].join(':');
		},
		parseInstanceId(id) {
			try {
				const match = /^intercom:v1:workspace:([^:]+):conversation:([^:]+)$/.exec(id);
				if (!match?.[1] || !match[2]) {
					throw new InvalidIntercomInstanceIdError();
				}
				const ref: IntercomConversationRef = {
					workspaceId: decodeURIComponent(match[1]),
					conversationId: decodeURIComponent(match[2]),
				};
				assertConversationRef(ref);
				if (channel.instanceId(ref) !== id) {
					throw new InvalidIntercomInstanceIdError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidIntercomInstanceIdError) throw error;
				throw new InvalidIntercomInstanceIdError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: IntercomChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createIntercomChannel() requires an options object.');
	}
	if (typeof options.clientSecret !== 'string' || options.clientSecret.length === 0) {
		throw new TypeError('createIntercomChannel() requires a non-empty clientSecret.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createIntercomChannel() requires a webhook handler.');
	}
}

function assertConversationRef(ref: IntercomConversationRef): void {
	if (!ref || typeof ref !== 'object') {
		throw new InvalidIntercomInputError('conversation');
	}
	if (typeof ref.workspaceId !== 'string' || ref.workspaceId.length === 0) {
		throw new InvalidIntercomInputError('conversation.workspaceId');
	}
	if (typeof ref.conversationId !== 'string' || ref.conversationId.length === 0) {
		throw new InvalidIntercomInputError('conversation.conversationId');
	}
}
