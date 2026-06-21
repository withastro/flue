import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createHttpChannel, type HttpChannel } from '../src/index.ts';

function channelApp(channel: HttpChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		if (route.method === 'POST') {
			app.post(route.path, route.handler);
		}
	}
	return app;
}

describe('createHttpChannel()', () => {
	it('delivers request to webhook when verification succeeds', async () => {
		const webhook = vi.fn().mockReturnValue({ status: 'ok' });
		const verify = vi.fn().mockResolvedValue(true);
		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-custom-signature': 'valid_sig',
			},
			body: JSON.stringify({ hello: 'world' }),
		});

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json).toEqual({ status: 'ok' });
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).toHaveBeenCalledOnce();

		const verifyArgs = verify.mock.calls[0];
		expect(verifyArgs?.[0]?.get('x-custom-signature')).toBe('valid_sig');
		expect(verifyArgs?.[1]).toBe(JSON.stringify({ hello: 'world' }));
		expect(verifyArgs?.[2]).toBeInstanceOf(Uint8Array);

		const webhookArgs = webhook.mock.calls[0]?.[0];
		expect(webhookArgs).toBeDefined();
		expect(webhookArgs.body).toBe(JSON.stringify({ hello: 'world' }));
		expect(webhookArgs.rawBody).toBeInstanceOf(Uint8Array);
		expect(webhookArgs.json).toEqual({ hello: 'world' });
	});

	it('returns a custom response when verification returns a Response object', async () => {
		const webhook = vi.fn();
		const verify = vi.fn().mockResolvedValue(new Response('custom forbidden', { status: 403 }));
		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		});

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('custom forbidden');
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).not.toHaveBeenCalled();
	});

	it('returns 401 when verification fails', async () => {
		const webhook = vi.fn();
		const verify = vi.fn().mockResolvedValue(false);
		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		});

		expect(response.status).toBe(401);
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).not.toHaveBeenCalled();
	});

	it('returns 401 when verification throws an error', async () => {
		const webhook = vi.fn();
		const verify = vi.fn().mockRejectedValue(new Error('verification failed'));
		const channel = createHttpChannel({
			verify,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		});

		expect(response.status).toBe(401);
		expect(verify).toHaveBeenCalledOnce();
		expect(webhook).not.toHaveBeenCalled();
	});

	it('processes plain text requests without parsing JSON', async () => {
		const webhook = vi.fn().mockReturnValue(new Response('raw response', { status: 201 }));
		const channel = createHttpChannel({
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
			},
			body: 'plain text content',
		});

		expect(response.status).toBe(201);
		const text = await response.text();
		expect(text).toBe('raw response');
		expect(webhook).toHaveBeenCalledOnce();

		const webhookArgs = webhook.mock.calls[0]?.[0];
		expect(webhookArgs.body).toBe('plain text content');
		expect(webhookArgs.json).toBeUndefined();
	});

	it('returns 400 on malformed JSON payload when Content-Type is application/json', async () => {
		const webhook = vi.fn();
		const channel = createHttpChannel({
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: '{ invalid json }',
		});

		expect(response.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('returns 413 when request body exceeds bodyLimit', async () => {
		const webhook = vi.fn();
		const channel = createHttpChannel({
			bodyLimit: 10,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
			},
			body: 'this body is longer than 10 bytes',
		});

		expect(response.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('returns 413 when content-length header exceeds bodyLimit', async () => {
		const webhook = vi.fn();
		const channel = createHttpChannel({
			bodyLimit: 10,
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
				'content-length': '20',
			},
			body: 'short',
		});

		expect(response.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('returns 400 when content-length header is invalid', async () => {
		const webhook = vi.fn();
		const channel = createHttpChannel({
			webhook,
		});
		const app = channelApp(channel);

		const response = await app.request('/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
				'content-length': 'not-a-number',
			},
			body: 'body',
		});

		expect(response.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});
});
