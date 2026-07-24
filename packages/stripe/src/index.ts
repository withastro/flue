import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import type Stripe from 'stripe';
import { createStripeWebhookHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';

interface StripeChannelOptionsBase {
	/** Project-owned Stripe SDK client used for official webhook verification. */
	client: Stripe;
	/** Signing secret for this Stripe event destination. */
	webhookSecret: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Signature timestamp tolerance in seconds. Defaults to Stripe's 300 seconds. */
	signatureToleranceSeconds?: number;
}

/** Configuration for ordinary snapshot webhook events. */
export interface StripeSnapshotChannelOptions<
	E extends Env = Env,
> extends StripeChannelOptionsBase {
	/** Snapshot events are the default payload mode. */
	eventPayload?: 'snapshot';
	/** Receives every verified snapshot event. */
	webhook(input: StripeSnapshotWebhookHandlerInput<E>): StripeHandlerResult;
}

/** Configuration for API v2 thin event notifications. */
export interface StripeThinChannelOptions<E extends Env = Env> extends StripeChannelOptionsBase {
	/** Selects API v2 thin event notifications. */
	eventPayload: 'thin';
	/** Receives every verified thin event notification. */
	webhook(input: StripeThinWebhookHandlerInput<E>): StripeHandlerResult;
}

export type StripeChannelOptions<E extends Env = Env> =
	StripeSnapshotChannelOptions<E> | StripeThinChannelOptions<E>;

export interface StripeSnapshotWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: Stripe.Event;
}

export interface StripeThinWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	event: Stripe.V2.Core.EventNotification;
}

type StripeHandlerValue = undefined | JsonValue | Response;

export type StripeHandlerResult = StripeHandlerValue | Promise<StripeHandlerValue>;

/** Verified Stripe ingress. */
export interface StripeChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/stripe', channel.route())`.
	 */
	route(): Hono<E>;
}

/**
 * Creates one verified Stripe webhook route.
 *
 * The channel is stateless and does not deduplicate or reorder Stripe events.
 */
export function createStripeChannel<E extends Env = Env>(
	options: StripeSnapshotChannelOptions<E>,
): StripeChannel<E>;
export function createStripeChannel<E extends Env = Env>(
	options: StripeThinChannelOptions<E>,
): StripeChannel<E>;
export function createStripeChannel<E extends Env = Env>(
	options: StripeChannelOptions<E>,
): StripeChannel<E>;
export function createStripeChannel<E extends Env = Env>(
	options: StripeChannelOptions<E>,
): StripeChannel<E> {
	validateOptions(options);
	const routes: readonly ChannelRouteDefinition<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createStripeWebhookHandler(options),
		},
	];
	return {
		routes,
		route: () => createChannelRouter(routes),
	};
}

function validateOptions<E extends Env>(options: StripeChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createStripeChannel() requires an options object.');
	}
	if (!isStripeClient(options.client)) {
		throw new TypeError('createStripeChannel() requires a Stripe client.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createStripeChannel() requires a non-empty webhookSecret.');
	}
	if (
		options.eventPayload !== undefined &&
		options.eventPayload !== 'snapshot' &&
		options.eventPayload !== 'thin'
	) {
		throw new TypeError('Stripe eventPayload must be "snapshot" or "thin".');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createStripeChannel() requires a webhook handler.');
	}
}

function isStripeClient(value: unknown): value is Stripe {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as {
		webhooks?: { constructEventAsync?: unknown };
		parseEventNotificationAsync?: unknown;
	};
	return (
		typeof candidate.webhooks?.constructEventAsync === 'function' &&
		typeof candidate.parseEventNotificationAsync === 'function'
	);
}
