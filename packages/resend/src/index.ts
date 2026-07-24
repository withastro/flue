import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import type { Resend, WebhookEvent, WebhookEventPayload } from 'resend';
import { createResendWebhookHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';
export type { WebhookEvent, WebhookEventPayload };

export interface ResendChannelOptions<E extends Env = Env> {
	/** Project-owned official Resend client used for webhook verification. */
	client: Resend;
	/** Signing secret for this Resend webhook endpoint. */
	webhookSecret: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified Resend webhook delivery. */
	webhook(input: ResendWebhookHandlerInput<E>): ResendHandlerResult;
}

/**
 * Provider-native verified webhook event: the official Resend
 * `WebhookEventPayload` union, forwarded with its original `snake_case` field
 * names and nesting. The channel never reshapes it into a Flue-owned form, so
 * `switch (event.type)` narrows each modeled variant.
 *
 * The official verifier (`client.webhooks.verify()`) returns the parsed body
 * for any authenticated delivery without restricting it to the modeled event
 * names, so a newly introduced provider event still reaches the handler at
 * runtime — it is simply typed as the current official union. Inspect
 * `event.type` to handle an event your installed `resend` version predates.
 */
export type ResendWebhookEvent = WebhookEventPayload;

export interface ResendWebhookDelivery {
	/** `svix-id`; use this for application-owned deduplication. */
	id: string;
	/** Signed Unix timestamp from `svix-timestamp`. */
	timestamp: string;
}

/** Input passed to the application after authentication and event validation. */
export interface ResendWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: ResendWebhookEvent;
	delivery: ResendWebhookDelivery;
}

type ResendHandlerValue = undefined | JsonValue | Response;

/**
 * Returning no value or JSON acknowledges with `200`. A returned `Response`
 * passes through; Resend retries any status other than `200`.
 */
export type ResendHandlerResult = ResendHandlerValue | Promise<ResendHandlerValue>;

/** Verified Resend ingress. */
export interface ResendChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/resend', channel.route())`.
	 */
	route(): Hono<E>;
}

/**
 * Creates one verified Resend webhook route.
 *
 * The route is fixed at `POST /webhook`. The channel is stateless and does not
 * deduplicate or reorder deliveries.
 */
export function createResendChannel<E extends Env = Env>(
	options: ResendChannelOptions<E>,
): ResendChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createResendWebhookHandler(options),
		},
	];
	return {
		routes,
		route: () => createChannelRouter(routes),
	};
}

function validateOptions<E extends Env>(options: ResendChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createResendChannel() requires an options object.');
	}
	if (!isResendClient(options.client)) {
		throw new TypeError('createResendChannel() requires a Resend client.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createResendChannel() requires a non-empty webhookSecret.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createResendChannel() requires a webhook handler.');
	}
}

function isResendClient(value: unknown): value is Resend {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as { webhooks?: { verify?: unknown } };
	return typeof candidate.webhooks?.verify === 'function';
}
