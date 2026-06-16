import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createNotionChannel, type NotionChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/notion workerd ingress', () => {
	it('executes exact-byte Web Crypto verification in workerd', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_worker_secret',
			webhook,
		});
		const body = ` {\n "id":"delivery_worker",\n "timestamp":"2026-06-13T22:10:00.000Z",\n "workspace_id":"workspace_worker",\n "workspace_name":"Worker",\n "subscription_id":"subscription_worker",\n "integration_id":"integration_worker",\n "authors":[{"id":"agent_worker","type":"agent"}],\n "attempt_number":2,\n "api_version":"2026-03-11",\n "type":"comment.created",\n "entity":{"id":"comment_worker","type":"comment"},\n "data":{"parent":{"id":"page_worker","type":"page"},"page_id":"page_worker"}\n} `;
		const signature = await signatureHeader(body, 'notion_worker_secret');
		const app = channelApp(notion);

		const response = await app.request(request(body, signature));
		const tampered = await app.request(
			request(body.replace('page_worker', 'page_changed'), signature),
		);

		expect(response.status).toBe(200);
		expect(tampered.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			id: 'delivery_worker',
			type: 'comment.created',
			attempt_number: 2,
		});
	});

	it('handles the unsigned setup request in workerd', async () => {
		const verification = vi.fn();
		const notion = createNotionChannel({
			verification,
			webhook() {},
		});

		const response = await channelApp(notion).request(
			request(JSON.stringify({ verification_token: 'notion_worker_setup', provider_added: true })),
		);

		expect(response.status).toBe(200);
		expect(verification).toHaveBeenCalledWith({
			c: expect.any(Object),
			verificationToken: 'notion_worker_setup',
		});
		expect(crypto.subtle).toBeDefined();
	});
});

function channelApp(channel: NotionChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function request(body: string, signature?: string): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(signature ? { 'x-notion-signature': signature } : {}),
		},
		body,
	});
}

async function signatureHeader(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sha256=${signature}`;
}
