import { Hono } from 'hono';
import Stripe from 'stripe';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createStripeChannel,
	type StripeChannel,
	type StripeSnapshotWebhookHandlerInput,
	type StripeThinWebhookHandlerInput,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('createStripeChannel()', () => {
	it('verifies exact snapshot bytes and delivers the native Stripe event', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_snapshot',
			webhook,
		});
		const body = ` {\n  "id":"evt_snapshot_1",\n  "object":"event",\n  "api_version":"2026-05-27.dahlia",\n  "created":1781395200,\n  "data":{"object":{"id":"cs_snapshot_1","object":"checkout.session","customer":"cus_amber"}},\n  "livemode":false,\n  "pending_webhooks":1,\n  "request":{"id":"req_snapshot_1","idempotency_key":null},\n  "type":"checkout.session.completed"\n} `;
		const signed = await signedRequest(body, 'whsec_snapshot');

		const response = await channelApp(stripe).request(signed);
		const changed = await channelApp(stripe).request(
			new Request(signed.url, {
				method: 'POST',
				headers: signed.headers,
				body: body.replace('cus_amber', 'cus_indigo'),
			}),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(400);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			event: {
				id: 'evt_snapshot_1',
				object: 'event',
				type: 'checkout.session.completed',
				data: {
					object: {
						id: 'cs_snapshot_1',
						object: 'checkout.session',
						customer: 'cus_amber',
					},
				},
			},
		});
	});

	it('forwards verified future snapshot event types without a Flue allowlist', async () => {
		const seen: string[] = [];
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_future',
			webhook({ event }) {
				seen.push(event.type as string);
			},
		});
		const body = JSON.stringify(
			snapshotEvent({
				id: 'evt_future_1',
				type: 'treasury.experimental_balance.available',
			}),
		);

		const response = await channelApp(stripe).request(await signedRequest(body, 'whsec_future'));

		expect(response.status).toBe(200);
		expect(seen).toEqual(['treasury.experimental_balance.available']);
	});

	it('parses explicit thin notifications with context and SDK fetch capabilities', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_thin',
			eventPayload: 'thin',
			webhook,
		});
		const body = JSON.stringify(thinEvent());

		const response = await channelApp(stripe).request(await signedRequest(body, 'whsec_thin'));

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		const event = webhook.mock.calls[0]?.[0].event;
		expect(event).toMatchObject({
			id: 'evt_thin_1',
			object: 'v2.core.event',
			type: 'v2.core.event_destination.ping',
			related_object: {
				id: 'ed_test_1',
				type: 'v2.core.event_destination',
				url: '/v2/core/event_destinations/ed_test_1',
			},
		});
		expect(event.context.toString()).toBe('acct_acme/store_west');
		expect(event.fetchEvent).toEqual(expect.any(Function));
		expect(event.fetchRelatedObject).toEqual(expect.any(Function));
	});

	it('forwards valid thin notifications without a related object', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_thin_without_related_object',
			eventPayload: 'thin',
			webhook,
		});
		const body = JSON.stringify({
			id: 'evt_thin_without_related_object',
			object: 'v2.core.event',
			context: 'acct_acme/store_west',
			created: '2026-06-13T20:10:00.000Z',
			livemode: false,
			type: 'v2.core.account_link.returned',
		});

		const response = await channelApp(stripe).request(
			await signedRequest(body, 'whsec_thin_without_related_object'),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		const event = webhook.mock.calls[0]?.[0].event;
		expect(event).toMatchObject({
			id: 'evt_thin_without_related_object',
			object: 'v2.core.event',
			type: 'v2.core.account_link.returned',
		});
		expect(event.related_object).toBeUndefined();
		await expect(event.fetchRelatedObject()).resolves.toBeNull();
	});

	it('rejects snapshot and thin payload mode mismatches before application code', async () => {
		const snapshotWebhook = vi.fn();
		const thinWebhook = vi.fn();
		const snapshot = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_modes',
			webhook: snapshotWebhook,
		});
		const thin = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_modes',
			eventPayload: 'thin',
			webhook: thinWebhook,
		});
		const snapshotBody = JSON.stringify(snapshotEvent());
		const thinBody = JSON.stringify(thinEvent());

		const thinToSnapshot = await channelApp(snapshot).request(
			await signedRequest(thinBody, 'whsec_modes'),
		);
		const snapshotToThin = await channelApp(thin).request(
			await signedRequest(snapshotBody, 'whsec_modes'),
		);

		expect(thinToSnapshot.status).toBe(400);
		expect(snapshotToThin.status).toBe(400);
		expect(snapshotWebhook).not.toHaveBeenCalled();
		expect(thinWebhook).not.toHaveBeenCalled();
	});

	it('rejects missing, malformed, altered, and stale signatures', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_auth',
			webhook,
		});
		const app = channelApp(stripe);
		const body = JSON.stringify(snapshotEvent());
		const timestamp = Math.floor(Date.now() / 1000);
		const valid = await signatureHeader(body, 'whsec_auth', timestamp);

		const missing = await app.request(jsonRequest(body));
		const malformed = await app.request(
			jsonRequest(body, { 'stripe-signature': 'not-a-stripe-signature' }),
		);
		const altered = await app.request(
			jsonRequest(body.replace('evt_snapshot_1', 'evt_altered_1'), {
				'stripe-signature': valid,
			}),
		);
		const stale = await app.request(await signedRequest(body, 'whsec_auth', timestamp - 301));

		expect(missing.status).toBe(400);
		expect(malformed.status).toBe(400);
		expect(altered.status).toBe(400);
		expect(stale.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('honors a configured signature tolerance and rotated signatures', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_rotation',
			signatureToleranceSeconds: 600,
			webhook,
		});
		const body = JSON.stringify(snapshotEvent());
		const timestamp = Math.floor(Date.now() / 1000) - 400;
		const valid = await signature(body, 'whsec_rotation', timestamp);
		const request = jsonRequest(body, {
			'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)},v1=${valid}`,
		});

		const response = await channelApp(stripe).request(request);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('rejects malformed signed JSON but forwards verified events without re-validating shape', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_schema',
			webhook,
		});
		const app = channelApp(stripe);

		// Unparseable JSON fails the official SDK's verify/parse and is rejected.
		const malformed = await app.request(await signedRequest('{"object":"event"', 'whsec_schema'));
		expect(malformed.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();

		// A verified, well-formed snapshot envelope is forwarded as-is: the channel
		// trusts the SDK's parse and no longer re-validates event-family fields.
		const minimal = await app.request(
			await signedRequest(
				JSON.stringify({ object: 'event', id: 'evt_minimal', type: 'customer.created' }),
				'whsec_schema',
			),
		);
		expect(minimal.status).toBe(200);
		expect(webhook).toHaveBeenCalledTimes(1);
	});

	it('enforces JSON media type and body limits with and without Content-Length', async () => {
		const webhook = vi.fn();
		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_body',
			bodyLimit: 128,
			webhook,
		});
		const app = channelApp(stripe);
		const body = JSON.stringify(
			snapshotEvent({ data: { object: { id: 'cus_large', note: 'x'.repeat(200) } } }),
		);

		const wrongMedia = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}',
			}),
		);
		const declaredLarge = await app.request(
			jsonRequest('{}', {
				'content-length': '129',
				'stripe-signature': await signatureHeader('{}', 'whsec_body'),
			}),
		);
		const streamedLarge = await app.request(await signedRequest(body, 'whsec_body'));

		expect(wrongMedia.status).toBe(415);
		expect(declaredLarge.status).toBe(413);
		expect(streamedLarge.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('uses empty 200, JSON, and Hono responses without a custom response API', async () => {
		const body = JSON.stringify(snapshotEvent());
		const empty = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_response',
			webhook: () => undefined,
		});
		const json = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_response',
			webhook: () => ({ received: true }),
		});
		const hono = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_response',
			webhook: ({ c }) => c.json({ retry: true }, 503),
		});

		const emptyResponse = await channelApp(empty).request(
			await signedRequest(body, 'whsec_response'),
		);
		const jsonResponse = await channelApp(json).request(
			await signedRequest(body, 'whsec_response'),
		);
		const honoResponse = await channelApp(hono).request(
			await signedRequest(body, 'whsec_response'),
		);

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(jsonResponse.status).toBe(200);
		expect(await jsonResponse.json()).toEqual({ received: true });
		expect(honoResponse.status).toBe(503);
		expect(await honoResponse.json()).toEqual({ retry: true });
	});

	it('returns 500 when application code throws', async () => {
		const body = JSON.stringify(snapshotEvent());
		const throwing = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_failure',
			webhook() {
				throw new Error('application failure');
			},
		});

		const throwingResponse = await channelApp(throwing).request(
			await signedRequest(body, 'whsec_failure'),
		);

		expect(throwingResponse.status).toBe(500);
	});

	it('serializes non-plain return values with JSON.stringify semantics', async () => {
		const body = JSON.stringify(snapshotEvent());
		const map = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_serialize',
			webhook: () => new Map() as never,
		});
		const notANumber = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_serialize',
			webhook: () => Number.NaN as never,
		});

		const mapResponse = await channelApp(map).request(await signedRequest(body, 'whsec_serialize'));
		const nanResponse = await channelApp(notANumber).request(
			await signedRequest(body, 'whsec_serialize'),
		);

		expect(mapResponse.status).toBe(200);
		expect(await mapResponse.json()).toEqual({});
		expect(nanResponse.status).toBe(200);
		expect(await nanResponse.json()).toBeNull();
	});

	it('validates constructor inputs and publishes only POST /webhook', () => {
		expect(() =>
			createStripeChannel({
				client: stripeClient(),
				webhookSecret: '',
				webhook: () => undefined,
			}),
		).toThrow(TypeError);
		expect(() =>
			createStripeChannel({
				client: {} as Stripe,
				webhookSecret: 'whsec_invalid',
				webhook: () => undefined,
			}),
		).toThrow(TypeError);
		expect(() =>
			createStripeChannel({
				client: stripeClient(),
				webhookSecret: 'whsec_invalid',
				bodyLimit: 0,
				webhook: () => undefined,
			}),
		).toThrow(TypeError);
		expect(() =>
			createStripeChannel({
				client: stripeClient(),
				webhookSecret: 'whsec_invalid',
				signatureToleranceSeconds: 0,
				webhook: () => undefined,
			}),
		).toThrow(TypeError);

		const stripe = createStripeChannel({
			client: stripeClient(),
			webhookSecret: 'whsec_route',
			webhook: () => undefined,
		});
		expect(stripe.routes).toHaveLength(1);
		expect(stripe.routes[0]).toMatchObject({ method: 'POST', path: '/webhook' });
	});

	it('discriminates snapshot and thin callback event types', () => {
		type TestEnv = { Bindings: { region: string } };
		createStripeChannel<TestEnv>({
			client: stripeClient(),
			webhookSecret: 'whsec_types',
			webhook(input) {
				expectTypeOf(input).toEqualTypeOf<StripeSnapshotWebhookHandlerInput<TestEnv>>();
			},
		});
		createStripeChannel<TestEnv>({
			client: stripeClient(),
			webhookSecret: 'whsec_types',
			eventPayload: 'thin',
			webhook(input) {
				expectTypeOf(input).toEqualTypeOf<StripeThinWebhookHandlerInput<TestEnv>>();
			},
		});
	});
});

function stripeClient(): Stripe {
	return new Stripe('sk_test_local_channel');
}

function channelApp(channel: StripeChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

async function signedRequest(
	body: string,
	secret: string,
	timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
	return jsonRequest(body, {
		'stripe-signature': await signatureHeader(body, secret, timestamp),
	});
}

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...headers,
		},
		body,
	});
}

async function signatureHeader(
	body: string,
	secret: string,
	timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
	return `t=${timestamp},v1=${await signature(body, secret, timestamp)}`;
}

async function signature(body: string, secret: string, timestamp: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const value = `${timestamp}.${body}`;
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function snapshotEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'evt_snapshot_1',
		object: 'event',
		api_version: '2026-05-27.dahlia',
		created: 1_781_395_200,
		data: { object: { id: 'cus_snapshot_1', object: 'customer' } },
		livemode: false,
		pending_webhooks: 1,
		request: { id: 'req_snapshot_1', idempotency_key: null },
		type: 'customer.created',
		...overrides,
	};
}

function thinEvent(): Record<string, unknown> {
	return {
		id: 'evt_thin_1',
		object: 'v2.core.event',
		context: 'acct_acme/store_west',
		created: '2026-06-13T20:00:00.000Z',
		livemode: false,
		reason: {
			type: 'request',
			request: { id: 'req_thin_1', idempotency_key: 'idem_thin_1' },
		},
		related_object: {
			id: 'ed_test_1',
			type: 'v2.core.event_destination',
			url: '/v2/core/event_destinations/ed_test_1',
		},
		type: 'v2.core.event_destination.ping',
	};
}
