import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import { createShopifyWebhookHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';

/** Ingress configuration for one Shopify app secret. */
export interface ShopifyChannelOptions<E extends Env = Env> {
	/** Current app client secret used to verify exact Shopify request bytes. */
	clientSecret: string;
	/**
	 * Previous app client secret accepted during Shopify's rotation propagation
	 * period. Remove it after deliveries use the current secret.
	 */
	previousClientSecret?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified JSON Shopify webhook delivery. */
	webhook(input: ShopifyWebhookHandlerInput<E>): ShopifyHandlerResult;
}

/**
 * Input delivered to the webhook callback.
 *
 * `payload` is Shopify's parsed JSON body with its original field names and
 * nesting. Its shape depends on the topic, API version, and subscription field
 * selection, so applications validate the fields they consume. Unsafe numeric
 * literals are preserved as strings so 64-bit Shopify identifiers are not
 * rounded by JavaScript.
 *
 * Delivery metadata is read from the provider's native headers through `c`,
 * for example `c.req.header('x-shopify-topic')` and
 * `c.req.header('x-shopify-shop-domain')`. The HMAC signs the body only, not
 * these headers, so they are routing context rather than an independent
 * cryptographic or authorization claim.
 */
export interface ShopifyWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Parsed provider JSON body. */
	payload: JsonValue;
	/** Exact UTF-8 body the signature was verified against. */
	rawBody: string;
}

type ShopifyHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or JSON acknowledges with `200`. A returned `Response`
 * passes through; Shopify retries non-2xx responses.
 */
export type ShopifyHandlerResult = ShopifyHandlerValue | Promise<ShopifyHandlerValue>;

/** Verified Shopify ingress. */
export interface ShopifyChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/shopify', channel.route())`.
	 */
	route(): Hono<E>;
}

/**
 * Creates one verified Shopify JSON webhook route.
 *
 * The route is fixed at `POST /webhook`. The channel is stateless and does not
 * deduplicate or reorder deliveries. Shopify allows five seconds for the whole
 * request and does not sign a timestamp, so admit durable work promptly and
 * rely on application-owned idempotency keyed on `x-shopify-webhook-id`.
 */
export function createShopifyChannel<E extends Env = Env>(
	options: ShopifyChannelOptions<E>,
): ShopifyChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createShopifyWebhookHandler(options),
		},
	];
	return {
		routes,
		route: () => createChannelRouter(routes),
	};
}

function validateOptions<E extends Env>(options: ShopifyChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createShopifyChannel() requires an options object.');
	}
	if (typeof options.clientSecret !== 'string' || options.clientSecret.length === 0) {
		throw new TypeError('createShopifyChannel() requires a non-empty clientSecret.');
	}
	if (
		options.previousClientSecret !== undefined &&
		(typeof options.previousClientSecret !== 'string' || options.previousClientSecret.length === 0)
	) {
		throw new TypeError('Shopify previousClientSecret must be a non-empty string.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createShopifyChannel() requires a webhook handler.');
	}
}
