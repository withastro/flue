import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createHttpChannel, type HttpChannel } from '../src/index.ts';

function channelApp(channel: HttpChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		app.on(route.method, route.path, route.handler);
	}
	return app;
}

describe('@flue/http workerd ingress', () => {
	it('receives and verifies a generic webhook payload in workerd', async () => {
		const webhook = vi.fn().mockReturnValue({ status: 'ok' });
		const verify = vi.fn().mockImplementation((headers: Headers, body: string) => {
			const expectedToken = 'workerd_secret_token';
			const token = headers.get('authorization');
			return token === expectedToken && body.includes('workerd_check');
		});

		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const body = JSON.stringify({ event: 'workerd_check', value: 42 });
		const request = new Request('https://example.test/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'workerd_secret_token',
			},
			body,
		});

		const response = await app.request(request);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json).toEqual({ status: 'ok' });
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).toHaveBeenCalledOnce();

		const webhookArgs = webhook.mock.calls[0]?.[0];
		expect(webhookArgs.body).toBe(body);
		expect(webhookArgs.json).toEqual({ event: 'workerd_check', value: 42 });
		expect(crypto.subtle).toBeDefined();
	});

	it('returns 401 on verification failure in workerd', async () => {
		const webhook = vi.fn();
		const verify = vi.fn().mockReturnValue(false);

		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const request = new Request('https://example.test/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: 'body',
		});

		const response = await app.request(request);

		expect(response.status).toBe(401);
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).not.toHaveBeenCalled();
	});
});
