import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import { createSalesforceMarketingCloudEventsHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';

/** One unsigned callback-ownership challenge sent while configuring ENS. */
export interface SalesforceMarketingCloudVerification {
	/** Callback id assigned by Marketing Cloud Engagement. */
	callbackId: string;
	/** One-time key submitted separately to the ENS verification API. */
	verificationKey: string;
}

/**
 * Broken-down composite tracking id present on transactional send and
 * engagement email families. Marketing Cloud delivers these as strings.
 */
export interface SalesforceMarketingCloudComposite {
	jobId?: string;
	batchId?: string;
	listId?: string;
	[key: string]: unknown;
}

/**
 * One provider-native Marketing Cloud Engagement ENS event, passed through
 * with Marketing Cloud's own field names and nesting.
 *
 * ENS event families do not share a closed schema: `eventCategoryType` is an
 * open taxonomy (`EngagementEvents.EmailOpen`, `TransactionalSendEvents.EmailSent`,
 * `AutomationEvents.*`, …) and the family-specific fields live in `info`.
 * Authenticated fields that this type does not model are forwarded unchanged,
 * so narrow on `eventCategoryType` and read the family fields you expect.
 */
export interface SalesforceMarketingCloudEvent {
	/** Open provider event taxonomy, such as `EngagementEvents.EmailOpen`. */
	eventCategoryType: string;
	/** Provider timestamp, forwarded without validating its representation. */
	timestampUTC?: unknown;
	/** Deprecated flattened tracking id, forwarded without shape validation. */
	compositeId?: unknown;
	/** Broken-down tracking id, forwarded without shape validation. */
	composite?: unknown;
	/** Send Definition customer key, forwarded without shape validation. */
	definitionKey?: unknown;
	/** Send Definition id, forwarded without shape validation. */
	definitionId?: unknown;
	/** Marketing Cloud business-unit id, forwarded without shape validation. */
	mid?: unknown;
	/** Marketing Cloud enterprise id, forwarded without shape validation. */
	eid?: unknown;
	/** Event-family-specific details, forwarded without shape validation. */
	info?: unknown;
	[key: string]: unknown;
}

/** One authenticated, ordered ENS delivery batch. */
export interface SalesforceMarketingCloudBatch {
	/** Provider-native events in delivery order. */
	events: SalesforceMarketingCloudEvent[];
	/** Exact UTF-8 body after successful signature verification. */
	rawBody: string;
}

export interface SalesforceMarketingCloudVerificationHandlerInput<E extends Env = Env> {
	/** Authentic Hono context for the discovered route. */
	c: Context<E>;
	/** Unsigned one-time setup challenge. */
	verification: SalesforceMarketingCloudVerification;
}

export interface SalesforceMarketingCloudEventsHandlerInput<E extends Env = Env> {
	/** Authentic Hono context for the discovered route. */
	c: Context<E>;
	/** Verified ENS delivery batch. */
	batch: SalesforceMarketingCloudBatch;
}

type SalesforceMarketingCloudHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or a JSON-compatible value responds with `200`. A returned
 * `Response` passes through. ENS treats any status outside `200`–`204` as a
 * delivery failure and retries.
 */
export type SalesforceMarketingCloudHandlerResult =
	SalesforceMarketingCloudHandlerValue | Promise<SalesforceMarketingCloudHandlerValue>;

/** Ingress configuration for one Marketing Cloud Engagement ENS callback. */
export interface SalesforceMarketingCloudChannelOptions<E extends Env = Env> {
	/**
	 * Callback-specific signature key returned once during ENS callback
	 * creation. Marketing Cloud uses this opaque string directly as the HMAC
	 * key; only the signature header is base64-decoded. Required.
	 */
	signatureKey: string;
	/** Optional callback-id restriction for the unsigned setup challenge. */
	callbackId?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/**
	 * Optional setup-only handler for the unsigned callback-verification
	 * challenge. Unsigned requests are rejected when this is omitted. Flue
	 * returns the required empty `200` after the handler completes.
	 */
	verification?(input: SalesforceMarketingCloudVerificationHandlerInput<E>): void | Promise<void>;
	/** Receives every authenticated ENS notification batch. */
	events(
		input: SalesforceMarketingCloudEventsHandlerInput<E>,
	): SalesforceMarketingCloudHandlerResult;
}

/** Verified Marketing Cloud Engagement ENS ingress. */
export interface SalesforceMarketingCloudChannel<E extends Env = Env> {
	/** Fixed route declarations published beneath the discovered channel path. */
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/sfmc', channel.route())`.
	 */
	route(): Hono<E>;
}

/**
 * Creates one Marketing Cloud Engagement Event Notification Service route.
 *
 * The route is fixed at `POST /events`. Callback verification is an unsigned
 * setup handshake; event batches require `x-sfmc-ens-signature`. Marketing
 * Cloud expects a prompt acknowledgement, so admit durable work quickly
 * instead of blocking on slow operations before returning, and rely on
 * idempotency because ENS delivers at least once.
 */
export function createSalesforceMarketingCloudChannel<E extends Env = Env>(
	options: SalesforceMarketingCloudChannelOptions<E>,
): SalesforceMarketingCloudChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'POST',
			path: '/events',
			handler: createSalesforceMarketingCloudEventsHandler(options),
		},
	];
	return {
		routes,
		route: () => createChannelRouter(routes),
	};
}

function validateOptions<E extends Env>(options: SalesforceMarketingCloudChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createSalesforceMarketingCloudChannel() requires an options object.');
	}
	if (typeof options.signatureKey !== 'string' || options.signatureKey.length === 0) {
		throw new TypeError('Salesforce Marketing Cloud signatureKey must be a non-empty string.');
	}
	if (
		options.callbackId !== undefined &&
		(typeof options.callbackId !== 'string' ||
			options.callbackId.length === 0 ||
			options.callbackId.trim() !== options.callbackId)
	) {
		throw new TypeError(
			'Salesforce Marketing Cloud callbackId must be a non-empty trimmed string.',
		);
	}
	if (options.verification !== undefined && typeof options.verification !== 'function') {
		throw new TypeError('Salesforce Marketing Cloud verification must be a function.');
	}
	if (typeof options.events !== 'function') {
		throw new TypeError('createSalesforceMarketingCloudChannel() requires an events handler.');
	}
}
