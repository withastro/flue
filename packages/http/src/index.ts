import type { Context, Env, Handler } from 'hono';
import { createHttpWebhookHandler } from './webhook.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Input passed to the application after custom request verification. */
export interface HttpWebhookHandlerInput<E extends Env = Env> {
	/** Hono context for the request. */
	c: Context<E>;
	/** Raw request body decoded as a UTF-8 string. */
	body: string;
	/** Raw request body bytes. */
	rawBody: Uint8Array;
	/** Parsed JSON payload if Content-Type was application/json, otherwise undefined. */
	json?: unknown;
}

export type HttpHandlerResult = undefined | JsonValue | Response;

export interface HttpChannelOptions<E extends Env = Env> {
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Custom request verification. Should return true if valid, false if invalid,
	 * or a custom Hono/fetch Response to override the default 401 response.
	 * Receives the headers, decoded body string, and raw body bytes.
	 */
	verify?(
		headers: Headers,
		body: string,
		rawBody: Uint8Array,
	): boolean | Response | Promise<boolean | Response>;
	/** Receives every verified HTTP webhook delivery. */
	webhook(input: HttpWebhookHandlerInput<E>): HttpHandlerResult | Promise<HttpHandlerResult>;
}

/** Verified HTTP Webhook Ingress. */
export interface HttpChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
}

/**
 * Creates one verified generic HTTP webhook route.
 *
 * The route is fixed at `POST /webhook`. The channel is stateless and does not
 * deduplicate or reorder deliveries.
 */
export function createHttpChannel<E extends Env = Env>(
	options: HttpChannelOptions<E>,
): HttpChannel<E> {
	validateOptions(options);
	return {
		routes: [
			{
				method: 'POST',
				path: '/webhook',
				handler: createHttpWebhookHandler(options),
			},
		],
	};
}

function validateOptions<E extends Env>(options: HttpChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createHttpChannel() requires an options object.');
	}
	if (options.verify !== undefined && typeof options.verify !== 'function') {
		throw new TypeError('createHttpChannel() verify option must be a function.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createHttpChannel() requires a webhook handler.');
	}
}
