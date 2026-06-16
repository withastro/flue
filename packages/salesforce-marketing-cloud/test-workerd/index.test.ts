import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createSalesforceMarketingCloudChannel,
	type SalesforceMarketingCloudChannel,
} from '../src/index.ts';

const encoder = new TextEncoder();
const SIGNATURE_KEY = 'mB7iPNv9hpWHmvQcxEwM7Zp6HSlFrFXhAN2TyFvncC4=';

describe('@flue/salesforce-marketing-cloud workerd ingress', () => {
	it('verifies exact notification bytes under nodejs_compat', async () => {
		const nodeGlobals = globalThis as typeof globalThis & {
			Buffer?: unknown;
			process?: unknown;
		};
		expect(nodeGlobals.process).toBeDefined();
		expect(nodeGlobals.Buffer).toBeDefined();
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				events,
			}),
		);
		const body = ` [\n{"eventCategoryType":"EngagementEvents.EmailClick","timestampUTC":1781398000123,"compositeId":"job-17.3.81","mid":51009,"eid":62008,"info":{"url":"https://example.test/pricing"}}\n] `;
		const signature = await sign(body);

		const response = await app.request(request(body, signature));
		const changed = await app.request(request(body.replace('/pricing', '/changed'), signature));
		const malformed = await app.request(request(body, 'not-base64'));

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(malformed.status).toBe(401);
		expect(events).toHaveBeenCalledOnce();
		expect(events.mock.calls[0]?.[0].batch).toMatchObject({
			rawBody: body,
			events: [
				{
					eventCategoryType: 'EngagementEvents.EmailClick',
					timestampUTC: 1781398000123,
					compositeId: 'job-17.3.81',
					mid: 51009,
					eid: 62008,
					info: { url: 'https://example.test/pricing' },
				},
			],
		});
	});

	it('handles callback verification and event-family differences in workerd', async () => {
		const verification = vi.fn();
		const events = vi.fn();
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				callbackId: 'callback-worker-14',
				verification,
				events,
			}),
		);
		const challenge = JSON.stringify({
			callbackId: 'callback-worker-14',
			verificationKey: 'verification-worker-14',
		});
		const body = JSON.stringify([
			{
				eventCategoryType: 'AutomationEvents.AutomationInstanceCompleted',
				timestampUTC: 1781398100000,
				mid: 51009,
				eid: 62008,
				automationId: 'automation-worker-3',
			},
			{
				eventCategoryType: 'TransactionalSendEvents.WhatsAppDelivered',
				timestampUTC: 1781398100300,
				mid: '51009',
				eid: '62008',
				to: '15555550124',
			},
		]);

		const challengeResponse = await app.request(request(challenge));
		const eventResponse = await app.request(request(body, await sign(body)));

		expect([challengeResponse.status, eventResponse.status]).toEqual([200, 200]);
		expect(verification).toHaveBeenCalledOnce();
		expect(events.mock.calls[0]?.[0].batch.events).toMatchObject([
			{
				eventCategoryType: 'AutomationEvents.AutomationInstanceCompleted',
				automationId: 'automation-worker-3',
			},
			{
				eventCategoryType: 'TransactionalSendEvents.WhatsAppDelivered',
				mid: '51009',
				eid: '62008',
				to: '15555550124',
			},
		]);
	});

	it('enforces streamed limits and handler results in workerd', async () => {
		const events = vi.fn(() => new Response('queued', { status: 203 }));
		const app = channelApp(
			createSalesforceMarketingCloudChannel({
				signatureKey: SIGNATURE_KEY,
				bodyLimit: 180,
				events,
			}),
		);
		const smallBody = JSON.stringify([
			{
				eventCategoryType: 'FutureEvents.Worker',
				timestampUTC: 1781398200000,
			},
		]);
		const largeBody = JSON.stringify([
			{
				eventCategoryType: 'FutureEvents.WorkerLarge',
				timestampUTC: 1781398200000,
				value: 'x'.repeat(220),
			},
		]);

		const accepted = await app.request(request(smallBody, await sign(smallBody)));
		const limited = await app.request(streamingRequest(largeBody, await sign(largeBody)));

		expect(accepted.status).toBe(203);
		await expect(accepted.text()).resolves.toBe('queued');
		expect(limited.status).toBe(413);
		expect(events).toHaveBeenCalledOnce();
	});
});

function channelApp(channel: SalesforceMarketingCloudChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function request(body: string, signature?: string): Request {
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
			controller.enqueue(bytes.slice(0, 100));
			controller.enqueue(bytes.slice(100));
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

async function sign(body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(SIGNATURE_KEY),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const bytes = encoder.encode(body);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
	let binary = '';
	for (const byte of signature) binary += String.fromCharCode(byte);
	return btoa(binary);
}
