import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createShopifyChannel,
	type ShopifyChannel,
	type ShopifyWebhookHandlerInput,
} from '../src/index.ts';

const encoder = new TextEncoder();
const CLIENT_SECRET = 'flue-shopify-current-secret';
const PREVIOUS_CLIENT_SECRET = 'flue-shopify-previous-secret';

describe('createShopifyChannel()', () => {
	it('delivers a verified JSON event when exact request bytes match', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = ` {\n "id": 940721724,\n "name": "#1001",\n "customer": {"id": 115310627314723954}\n} `;
		const headers = await shopifyHeaders(body, {
			topic: 'orders/create',
			webhookId: '3f884e50-7f2f-48b1-a85b-1f5f1d499173',
			eventId: '9f66d8cb-82e2-4fd7-b70d-369ec19ddc2e',
			triggeredAt: '2026-06-13T23:45:10.123456Z',
			subTopic: 'online-store',
		});

		const response = await app.request(jsonRequest(body, headers));
		const tampered = await app.request(jsonRequest(body.replace('#1001', '#changed'), headers));

		expect(response.status).toBe(200);
		expect(tampered.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		const input = webhook.mock.calls[0]?.[0] as ShopifyWebhookHandlerInput;
		expect(input).toMatchObject({
			c: expect.any(Object),
			payload: {
				id: 940721724,
				name: '#1001',
				customer: { id: '115310627314723954' },
			},
			rawBody: body,
		});
		// Delivery metadata is read from the provider's native headers through `c`.
		expect(input.c.req.header('x-shopify-topic')).toBe('orders/create');
		expect(input.c.req.header('x-shopify-shop-domain')).toBe('flue-fixtures.myshopify.com');
		expect(input.c.req.header('x-shopify-api-version')).toBe('2026-04');
		expect(input.c.req.header('x-shopify-webhook-id')).toBe('3f884e50-7f2f-48b1-a85b-1f5f1d499173');
		expect(input.c.req.header('x-shopify-event-id')).toBe('9f66d8cb-82e2-4fd7-b70d-369ec19ddc2e');
		expect(input.c.req.header('x-shopify-triggered-at')).toBe('2026-06-13T23:45:10.123456Z');
		expect(input.c.req.header('x-shopify-sub-topic')).toBe('online-store');
	});

	it('accepts the previous client secret during a rotation overlap', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				previousClientSecret: PREVIOUS_CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ shop_id: 7123498765 });

		const previousResponse = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					secret: PREVIOUS_CLIENT_SECRET,
					topic: 'shop/redact',
					webhookId: 'e5f7ce08-306f-4cd4-95d7-d85815f45d5b',
				}),
			),
		);
		const currentResponse = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					topic: 'shop/redact',
					webhookId: '3330580b-7200-44ae-92f9-83b5482a2e46',
				}),
			),
		);

		expect(previousResponse.status).toBe(200);
		expect(currentResponse.status).toBe(200);
		expect(webhook).toHaveBeenCalledTimes(2);
	});

	it('preserves future and compliance topics without requiring a closed payload schema', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const deliveries = [
			{
				topic: 'customers/data_request',
				body: JSON.stringify({
					shop_id: 954889,
					shop_domain: 'flue-fixtures.myshopify.com',
					customer: { id: 191167 },
					orders_requested: ['gid://shopify/Order/299938'],
				}),
			},
			{
				topic: 'inventory_forecasts/recalculated',
				body: JSON.stringify({ forecast: [1, 2, 3], source: null }),
			},
		];

		for (const [index, delivery] of deliveries.entries()) {
			const response = await app.request(
				jsonRequest(
					delivery.body,
					await shopifyHeaders(delivery.body, {
						topic: delivery.topic,
						webhookId: `delivery-${index}`,
					}),
				),
			);
			expect(response.status).toBe(200);
		}

		expect(webhook.mock.calls.map(([input]) => input.c.req.header('x-shopify-topic'))).toEqual([
			'customers/data_request',
			'inventory_forecasts/recalculated',
		]);
		expect(webhook.mock.calls[1]?.[0].payload).toEqual({
			forecast: [1, 2, 3],
			source: null,
		});
	});

	it('rejects missing, malformed, and incorrect authentication', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ id: 101 });
		const valid = await shopifyHeaders(body, {
			topic: 'products/update',
			webhookId: 'valid-auth-delivery',
		});

		const responses = await Promise.all([
			app.request(jsonRequest(body, without(valid, 'x-shopify-hmac-sha256'))),
			app.request(
				jsonRequest(body, {
					...valid,
					'x-shopify-hmac-sha256': 'not-base64',
				}),
			),
			app.request(
				jsonRequest(body, {
					...valid,
					'x-shopify-hmac-sha256': await hmac('different-secret', body),
				}),
			),
		]);

		expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('delivers verified bodies without curating or requiring delivery metadata headers', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook,
			}),
		);
		const body = JSON.stringify({ id: 202 });
		const valid = await shopifyHeaders(body, {
			topic: 'products/delete',
			webhookId: 'metadata-delivery',
		});

		// The channel verifies the body signature only; it does not require or
		// validate the delivery metadata headers. Applications read whatever
		// headers they need from `c` and validate them there.
		const responses = await Promise.all([
			app.request(jsonRequest(body, without(valid, 'x-shopify-topic'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-shop-domain'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-api-version'))),
			app.request(jsonRequest(body, without(valid, 'x-shopify-webhook-id'))),
			app.request(jsonRequest(body, { ...valid, 'x-shopify-event-id': '' })),
			app.request(jsonRequest(body, { ...valid, 'x-shopify-sub-topic': '' })),
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
		expect(webhook).toHaveBeenCalledTimes(6);
		// A delivery with the topic header removed still reaches the handler;
		// the application sees `undefined` for that header.
		expect(webhook.mock.calls[0]?.[0].c.req.header('x-shopify-topic')).toBeUndefined();
	});

	it('rejects unsupported media, malformed JSON, invalid UTF-8, and oversized bodies', async () => {
		const webhook = vi.fn();
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				bodyLimit: 128,
				webhook,
			}),
		);
		const malformedJson = '{"id":';
		const malformedHeaders = await shopifyHeaders(malformedJson, {
			topic: 'orders/create',
			webhookId: 'malformed-json',
		});
		const invalidBytes = new Uint8Array([0xff]);
		const invalidHeaders = await shopifyHeaders(invalidBytes, {
			topic: 'orders/create',
			webhookId: 'invalid-utf8',
		});
		const shortBody = '{}';
		const declaredHeaders = await shopifyHeaders(shortBody, {
			topic: 'orders/create',
			webhookId: 'declared-size',
		});
		const streamedBody = JSON.stringify({ value: 'x'.repeat(140) });
		const streamedHeaders = await shopifyHeaders(streamedBody, {
			topic: 'orders/create',
			webhookId: 'streamed-size',
		});

		const unsupported = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/xml' },
				body: '<order />',
			}),
		);
		const malformed = await app.request(jsonRequest(malformedJson, malformedHeaders));
		const invalidUtf8 = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...invalidHeaders },
				body: invalidBytes,
			}),
		);
		const invalidLength = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '128bytes',
					...declaredHeaders,
				},
				body: shortBody,
			}),
		);
		const declared = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '129',
					...declaredHeaders,
				},
				body: shortBody,
			}),
		);
		const streamed = await app.request(streamingRequest(streamedBody, streamedHeaders));

		expect([
			unsupported.status,
			malformed.status,
			invalidUtf8.status,
			invalidLength.status,
			declared.status,
			streamed.status,
		]).toEqual([415, 400, 400, 400, 413, 413]);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('uses an empty 200 when no result is returned, serializes JSON, and passes Responses through', async () => {
		const body = JSON.stringify({ id: 303 });
		const outcomes: Array<undefined | object | number | Response> = [
			undefined,
			{ accepted: true },
			new Response('accepted later', {
				status: 202,
				headers: { 'x-result': 'response' },
			}),
			Number.NaN,
		];
		const responses: Response[] = [];

		for (const [index, outcome] of outcomes.entries()) {
			const app = channelApp(
				createShopifyChannel({
					clientSecret: CLIENT_SECRET,
					webhook() {
						return outcome as never;
					},
				}),
			);
			responses.push(
				await app.request(
					jsonRequest(
						body,
						await shopifyHeaders(body, {
							topic: 'orders/updated',
							webhookId: `handler-${index}`,
						}),
					),
				),
			);
		}

		expect(responses.map((response) => response.status)).toEqual([200, 200, 202, 200]);
		await expect(responses[0]?.text()).resolves.toBe('');
		await expect(responses[1]?.json()).resolves.toEqual({ accepted: true });
		await expect(responses[2]?.text()).resolves.toBe('accepted later');
		expect(responses[2]?.headers.get('x-result')).toBe('response');
		// A non-finite number is no longer rejected closed: Response.json mirrors
		// JSON.stringify and serializes NaN to null, acknowledging with 200.
		await expect(responses[3]?.json()).resolves.toBeNull();
	});

	it('lets the Hono error handler handle webhook callback failures', async () => {
		const failure = new Error('handler failed');
		const app = channelApp(
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook() {
					throw failure;
				},
			}),
		);
		let received: Error | undefined;
		app.onError((error, c) => {
			received = error;
			return c.text('handled', 503);
		});
		const body = JSON.stringify({ id: 404 });

		const response = await app.request(
			jsonRequest(
				body,
				await shopifyHeaders(body, {
					topic: 'orders/updated',
					webhookId: 'handler-error',
				}),
			),
		);

		expect(response.status).toBe(503);
		await expect(response.text()).resolves.toBe('handled');
		expect(received).toBe(failure);
	});

	it('validates constructor options and publishes only the fixed webhook route', () => {
		const shopify = createShopifyChannel({
			clientSecret: CLIENT_SECRET,
			webhook() {},
		});

		expect(shopify.routes.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: 'POST', path: '/webhook' },
		]);
		expect(() => createShopifyChannel(undefined as never)).toThrow(TypeError);
		expect(() => createShopifyChannel({ clientSecret: '', webhook() {} })).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				previousClientSecret: '',
				webhook() {},
			}),
		).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				webhook: undefined as never,
			}),
		).toThrow(TypeError);
		expect(() =>
			createShopifyChannel({
				clientSecret: CLIENT_SECRET,
				bodyLimit: 0,
				webhook() {},
			}),
		).toThrow(TypeError);

		type CustomEnv = { Bindings: { SHOPIFY_AUDIT_BUCKET: string } };
		expectTypeOf<ShopifyWebhookHandlerInput<CustomEnv>['c']['env']>().toEqualTypeOf<{
			SHOPIFY_AUDIT_BUCKET: string;
		}>();
		expectTypeOf(shopify).toEqualTypeOf<ShopifyChannel>();
	});
});

function channelApp(channel: ShopifyChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function jsonRequest(body: string, headers: Record<string, string>): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
		body,
	});
}

function streamingRequest(body: string, headers: Record<string, string>): Request {
	const bytes = encoder.encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 64));
			controller.enqueue(bytes.slice(64));
			controller.close();
		},
	});
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: stream,
		duplex: 'half',
	} as RequestInit);
}

async function shopifyHeaders(
	body: string | Uint8Array,
	options: {
		topic: string;
		webhookId: string;
		secret?: string;
		eventId?: string;
		triggeredAt?: string;
		subTopic?: string;
	},
): Promise<Record<string, string>> {
	return {
		'x-shopify-hmac-sha256': await hmac(options.secret ?? CLIENT_SECRET, body),
		'x-shopify-topic': options.topic,
		'x-shopify-shop-domain': 'flue-fixtures.myshopify.com',
		'x-shopify-api-version': '2026-04',
		'x-shopify-webhook-id': options.webhookId,
		...(options.eventId ? { 'x-shopify-event-id': options.eventId } : {}),
		...(options.triggeredAt ? { 'x-shopify-triggered-at': options.triggeredAt } : {}),
		...(options.subTopic ? { 'x-shopify-sub-topic': options.subTopic } : {}),
	};
}

async function hmac(secret: string, body: string | Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			'HMAC',
			key,
			typeof body === 'string' ? encoder.encode(body) : copyArrayBuffer(body),
		),
	);
	return base64(signature);
}

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function without(headers: Record<string, string>, name: string): Record<string, string> {
	const copy = { ...headers };
	delete copy[name];
	return copy;
}
