import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createSalesforceMarketingCloudChannel,
	type SalesforceMarketingCloudChannel,
	type SalesforceMarketingCloudEventsHandlerInput,
} from '../src/index.ts';

const encoder = new TextEncoder();
const SIGNATURE_KEY = 'V27FXfqI3DnhfQW1bhFDeJixpt8eDAY5R24UJI3cK6M=';
const CALLBACK_ID = '65b885ab-c2b4-46fe-85d0-d6cb8be8057d';

describe('createSalesforceMarketingCloudChannel()', () => {
	it('delivers an ordered native batch when the exact request bytes are signed', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const body = ` [\n {"eventCategoryType":"TransactionalSendEvents.EmailSent","timestampUTC":1781397000123,"compositeId":"job-41.7.92","mid":412001,"eid":78002,"info":{"to":"buyer@example.test","messageKey":"message-node-1"}},\n {"eventCategoryType":"EngagementEvents.EmailOpen","timestampUTC":1781397000456,"mid":412001,"eid":78002,"info":{"ipAddress":"192.0.2.42"},"providerAdded":"preserved"}\n] `;
		const signature = await sign(body);

		const response = await app.request(request(body, signature));
		const tampered = await app.request(
			request(body.replace('buyer@example.test', 'attacker@example.test'), signature),
		);

		expect(response.status).toBe(200);
		expect(tampered.status).toBe(401);
		expect(events).toHaveBeenCalledOnce();
		expect(events.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			batch: {
				rawBody: body,
				events: [
					{
						eventCategoryType: 'TransactionalSendEvents.EmailSent',
						timestampUTC: 1781397000123,
						compositeId: 'job-41.7.92',
						mid: 412001,
						eid: 78002,
						info: {
							to: 'buyer@example.test',
							messageKey: 'message-node-1',
						},
					},
					{
						eventCategoryType: 'EngagementEvents.EmailOpen',
						timestampUTC: 1781397000456,
						info: { ipAddress: '192.0.2.42' },
						providerAdded: 'preserved',
					},
				],
			},
		});
		expect(events.mock.calls[0]?.[0].batch.events[0]).not.toHaveProperty('raw');
	});

	it('forwards documented ENS event-family differences without reshaping provider fields', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const body = JSON.stringify([
			{
				eventCategoryType: 'AutomationEvents.AutomationInstanceStarted',
				timestampUTC: 1781397100000,
				mid: 412001,
				eid: 78002,
				automationId: 'automation-19',
				automationInstanceId: 'instance-27',
				automationName: 'Nightly audience refresh',
			},
			{
				eventCategoryType: 'TransactionalSendEvents.WhatsAppSent',
				timestampUTC: 1781397100300,
				mid: '412001',
				eid: '78002',
				channelId: 'whatsapp-channel-6',
				to: '15555550123',
				messageKey: 'message-wa-8',
			},
		]);

		const response = await app.request(request(body, await sign(body)));

		expect(response.status).toBe(200);
		expect(events.mock.calls[0]?.[0].batch.events).toEqual([
			{
				eventCategoryType: 'AutomationEvents.AutomationInstanceStarted',
				timestampUTC: 1781397100000,
				mid: 412001,
				eid: 78002,
				automationId: 'automation-19',
				automationInstanceId: 'instance-27',
				automationName: 'Nightly audience refresh',
			},
			{
				eventCategoryType: 'TransactionalSendEvents.WhatsAppSent',
				timestampUTC: 1781397100300,
				mid: '412001',
				eid: '78002',
				channelId: 'whatsapp-channel-6',
				to: '15555550123',
				messageKey: 'message-wa-8',
			},
		]);
	});

	it('handles only the exact unsigned callback verification payload', async () => {
		const verification = vi.fn();
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				callbackId: CALLBACK_ID,
				verification,
				events,
			}),
		);
		const challenge = JSON.stringify({
			callbackId: CALLBACK_ID,
			verificationKey: 'one-time-verification-key-node',
		});
		const extra = JSON.stringify({
			callbackId: CALLBACK_ID,
			verificationKey: 'one-time-verification-key-node',
			eventCategoryType: 'attacker-controlled',
		});
		const mismatch = JSON.stringify({
			callbackId: 'different-callback-id',
			verificationKey: 'one-time-verification-key-node',
		});

		const responses = await Promise.all([
			app.request(request(challenge)),
			app.request(request(extra)),
			app.request(request(mismatch)),
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 401, 403]);
		expect(verification).toHaveBeenCalledOnce();
		expect(verification.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			verification: {
				callbackId: CALLBACK_ID,
				verificationKey: 'one-time-verification-key-node',
			},
		});
		expect(events).not.toHaveBeenCalled();
	});

	it('rejects malformed verification, signatures, media, bodies, and event batches', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const validBody = eventBatch();
		const malformedJson = '[';
		const objectBody = JSON.stringify({ eventCategoryType: 'NotABatch', timestampUTC: 1 });
		const emptyBatch = '[]';
		const invalidEvent = JSON.stringify([{ eventCategoryType: '', timestampUTC: -1 }]);
		const invalidBytes = new Uint8Array([0xff]);

		const responses = [
			await app.request(
				new Request('https://example.test/events', {
					method: 'POST',
					headers: { 'content-type': 'text/plain' },
					body: validBody,
				}),
			),
			await app.request(request(validBody)),
			await app.request(request(validBody, 'not-base64')),
			await app.request(request(validBody, await sign(validBody, 'different-key'))),
			await app.request(request(malformedJson, await sign(malformedJson))),
			await app.request(request(objectBody, await sign(objectBody))),
			await app.request(request(emptyBatch, await sign(emptyBatch))),
			await app.request(request(invalidEvent, await sign(invalidEvent))),
			await app.request(
				new Request('https://example.test/events', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-sfmc-ens-signature': await sign(invalidBytes),
					},
					body: invalidBytes,
				}),
			),
		];

		expect(responses.map((response) => response.status)).toEqual([
			415, 401, 401, 401, 400, 400, 400, 400, 400,
		]);
		expect(events).not.toHaveBeenCalled();
	});

	it('accepts the maximum ENS batch and forwards unmodeled optional fields unchanged', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const maximumBatch = JSON.stringify(
			Array.from({ length: 1000 }, (_, index) => ({
				eventCategoryType: 'FutureEvents.BatchItem',
				timestampUTC: 1781397250000 + index,
				providerIndex: index,
			})),
		);
		const oversizedBatch = JSON.stringify([
			...JSON.parse(maximumBatch),
			{
				eventCategoryType: 'FutureEvents.BatchItem',
				timestampUTC: 1781397251000,
			},
		]);
		const unmodeledOptionalFields = [
			{ eventCategoryType: 'FutureEvents.Composite', timestampUTC: 1, compositeId: '' },
			{ eventCategoryType: 'FutureEvents.Mid', timestampUTC: 1, mid: 0 },
			{ eventCategoryType: 'FutureEvents.Eid', timestampUTC: 1, eid: [] },
			{ eventCategoryType: 'FutureEvents.Info', timestampUTC: 1, info: [] },
			// timestampUTC is not validated: families may omit it or send a
			// non-integer representation, and it forwards unchanged either way.
			{ eventCategoryType: 'FutureEvents.NoTimestamp', other: true },
			{ eventCategoryType: 'FutureEvents.StringTimestamp', timestampUTC: '2026-06-13T00:00:00Z' },
		];

		const responses = [
			await app.request(request(maximumBatch, await sign(maximumBatch))),
			await app.request(request(oversizedBatch, await sign(oversizedBatch))),
		];
		for (const event of unmodeledOptionalFields) {
			const body = JSON.stringify([event]);
			responses.push(await app.request(request(body, await sign(body))));
		}

		expect(responses.map((response) => response.status)).toEqual([
			200, 400, 200, 200, 200, 200, 200, 200,
		]);
		expect(events).toHaveBeenCalledTimes(7);
		expect(events.mock.calls[0]?.[0].batch.events).toHaveLength(1000);
		expect(events.mock.calls.slice(1).map(([input]) => input.batch.events[0])).toEqual(
			unmodeledOptionalFields,
		);
	});

	it('requires a callback signature key at construction', () => {
		const events = vi.fn();

		expect(() =>
			createSalesforceMarketingCloudChannel({ events } as unknown as Parameters<
				typeof createSalesforceMarketingCloudChannel
			>[0]),
		).toThrow('signatureKey must be a non-empty string');
		expect(events).not.toHaveBeenCalled();
	});

	it('rejects unsigned setup requests when no verification handler is configured', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const challenge = JSON.stringify({
			callbackId: CALLBACK_ID,
			verificationKey: 'one-time-verification-key-node',
		});

		const response = await app.request(request(challenge));

		expect(response.status).toBe(401);
		expect(events).not.toHaveBeenCalled();
	});

	it('enforces declared and streamed body limits', async () => {
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				bodyLimit: 128,
				events,
			}),
		);
		const shortBody = eventBatch();
		const largeBody = JSON.stringify([
			{
				eventCategoryType: 'FutureEvents.Large',
				timestampUTC: 1781397200000,
				value: 'x'.repeat(180),
			},
		]);

		const invalidLength = await app.request(
			new Request('https://example.test/events', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': 'many',
					'x-sfmc-ens-signature': await sign(shortBody),
				},
				body: shortBody,
			}),
		);
		const declared = await app.request(
			new Request('https://example.test/events', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '129',
					'x-sfmc-ens-signature': await sign(shortBody),
				},
				body: shortBody,
			}),
		);
		const streamed = await app.request(streamingRequest(largeBody, await sign(largeBody)));

		expect([invalidLength.status, declared.status, streamed.status]).toEqual([400, 413, 413]);
		expect(events).not.toHaveBeenCalled();
	});

	it('serializes supported results and preserves application response statuses', async () => {
		const outcomes: Array<undefined | object | Response | bigint | Error> = [
			undefined,
			{ received: true },
			new Response('accepted', { status: 202, headers: { 'x-result': 'custom' } }),
			new Response(null, { status: 205 }),
			1n,
			new Error('handler failed'),
		];
		const responses: Response[] = [];

		for (const outcome of outcomes) {
			const app = channelApp(
				createSalesforceMarketingCloudChannel({
					signatureKey: SIGNATURE_KEY,
					events() {
						if (outcome instanceof Error) throw outcome;
						return outcome as never;
					},
				}),
			);
			const body = eventBatch();
			responses.push(await app.request(request(body, await sign(body))));
		}

		expect(responses.map((response) => response.status)).toEqual([200, 200, 202, 205, 500, 500]);
		await expect(responses[1]?.json()).resolves.toEqual({ received: true });
		await expect(responses[2]?.text()).resolves.toBe('accepted');
		expect(responses[2]?.headers.get('x-result')).toBe('custom');
	});

	it('publishes one fixed POST events route and preserves Hono environment types', () => {
		type Bindings = { SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY: string };
		type Variables = { requestId: string };
		type AppEnv = { Bindings: Bindings; Variables: Variables };

		const channel = createSalesforceMarketingCloudChannel<AppEnv>({
			signatureKey: SIGNATURE_KEY,
			events(input) {
				expectTypeOf(input).toEqualTypeOf<SalesforceMarketingCloudEventsHandlerInput<AppEnv>>();
				expectTypeOf(input.c.env).toEqualTypeOf<Bindings>();
				expectTypeOf(input.c.get('requestId')).toEqualTypeOf<string>();
				type Event = (typeof input.batch.events)[number];
				expectTypeOf<Event['eventCategoryType']>().toEqualTypeOf<string>();
				expectTypeOf<Event['timestampUTC']>().toEqualTypeOf<unknown>();
				expectTypeOf<Event['composite']>().toEqualTypeOf<unknown>();
				expectTypeOf<Event['info']>().toEqualTypeOf<unknown>();
			},
		});

		expect(channel.routes).toHaveLength(1);
		expect(channel.routes[0]).toMatchObject({ method: 'POST', path: '/events' });
	});

	it('validates constructor options before publishing a route', () => {
		expect(() =>
			createSalesforceMarketingCloudChannel({
				signatureKey: '',
				events() {},
			}),
		).toThrow('signatureKey must be a non-empty string');
		expect(() =>
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				callbackId: ' callback-id ',
				events() {},
			}),
		).toThrow('callbackId must be a non-empty trimmed string');
		expect(() =>
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				bodyLimit: 0,
				events() {},
			}),
		).toThrow('bodyLimit must be a positive integer');
	});
});

function channelApp(channel: SalesforceMarketingCloudChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function eventBatch(): string {
	return JSON.stringify([
		{
			eventCategoryType: 'TransactionalSendEvents.EmailSent',
			timestampUTC: 1781397000123,
			compositeId: 'job-41.7.92',
			mid: 412001,
			eid: 78002,
			info: { to: 'buyer@example.test', messageKey: 'message-node-1' },
		},
	]);
}

function request(body: BodyInit, signature?: string): Request {
	return new Request('https://example.test/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(signature === undefined ? {} : { 'x-sfmc-ens-signature': signature }),
		},
		body,
	});
}

function streamingRequest(body: string, signature: string): Request {
	const bytes = encoder.encode(body);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, 80));
			controller.enqueue(bytes.slice(80));
			controller.close();
		},
	});
	return new Request('https://example.test/events', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-sfmc-ens-signature': signature,
		},
		body: stream,
		duplex: 'half',
	} as RequestInit);
}

async function sign(body: string | Uint8Array, key = SIGNATURE_KEY): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const bytes = typeof body === 'string' ? encoder.encode(body) : body;
	const signature = new Uint8Array(
		await crypto.subtle.sign('HMAC', cryptoKey, copyArrayBuffer(bytes)),
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
