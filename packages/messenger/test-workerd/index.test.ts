import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMessengerChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/messenger workerd ingress', () => {
	it('performs GET verification and exact-body HMAC validation in workerd', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'worker-app-secret',
			verifyToken: 'worker-verify-token',
			pageId: 'page_worker_71',
			webhook,
		});
		const app = new Hono();
		for (const route of channel.routes) {
			app.on(route.method, `/channels/messenger${route.path}`, route.handler);
		}
		const verification = await app.request(
			'https://worker.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=worker-challenge&hub.verify_token=worker-verify-token',
		);
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_worker_71',
					time: 1_781_351_000_001,
					messaging: [
						{
							sender: { id: 'psid_worker_72' },
							recipient: { id: 'page_worker_71' },
							timestamp: 1_781_351_000_002,
							message: {
								mid: 'm_worker_73',
								text: 'Worker café message',
							},
						},
					],
				},
			],
		});
		const signature = await signatureFor('worker-app-secret', body);
		const accepted = await app.request(
			new Request('https://worker.example.test/channels/messenger/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-hub-signature-256': signature,
				},
				body,
			}),
		);
		const rejected = await app.request(
			new Request('https://worker.example.test/channels/messenger/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-hub-signature-256': signature,
				},
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(verification.status).toBe(200);
		expect(await verification.text()).toBe('worker-challenge');
		expect(accepted.status).toBe(200);
		expect(await accepted.text()).toBe('EVENT_RECEIVED');
		expect(rejected.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0].payload.entry[0]?.messaging[0]).toMatchObject({
			sender: { id: 'psid_worker_72' },
			recipient: { id: 'page_worker_71' },
			message: {
				mid: 'm_worker_73',
				text: 'Worker café message',
			},
		});
	});
});

async function signatureFor(appSecret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(appSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
