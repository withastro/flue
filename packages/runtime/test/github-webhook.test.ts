import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import { createGitHubChannelRouter, createGitHubWebhook } from '../src/github.ts';
import {
	configureFlueRuntime,
	InMemoryDispatchQueue,
	type DispatchInput,
} from '../src/internal.ts';

describe('GitHub webhook channel', () => {
	it('normalizes signed GitHub webhooks and fans out to subscribed agents', async () => {
		const received: unknown[] = [];
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				triage: async ({ delivery }) => received.push(delivery),
			},
			manifest: {
				agents: [{ name: 'triage', channels: { github: true }, receive: true, created: true }],
			},
		});

		const body = JSON.stringify({ action: 'opened', repository: { full_name: 'flue/test' }, sender: { login: 'octocat' } });
		const app = new Hono();
		app.route('/', flue());
		app.route('/webhooks/github', createGitHubChannelRouter({ webhookSecret: 'secret' }));
		const res = await app.fetch(new Request('http://localhost/webhooks/github', {
			method: 'POST',
			headers: {
				'x-github-delivery': 'delivery-1',
				'x-github-event': 'issues',
				'x-hub-signature-256': await signature('secret', body),
			},
			body,
		}));

		expect(res.status).toBe(202);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			id: 'delivery-1',
			channel: 'github',
			type: 'issues',
			data: {
				event: 'issues',
				deliveryId: 'delivery-1',
				action: 'opened',
				repository: { full_name: 'flue/test' },
				sender: { login: 'octocat' },
			},
		});
	});

	it('rejects invalid GitHub webhook signatures', async () => {
		const app = new Hono();
		app.route('/', flue());
		app.route('/webhooks/github', createGitHubChannelRouter({ webhookSecret: 'secret' }));
		const res = await app.fetch(new Request('http://localhost/webhooks/github', {
			method: 'POST',
			headers: {
				'x-github-delivery': 'delivery-1',
				'x-github-event': 'issues',
				'x-hub-signature-256': 'sha256=bad',
			},
			body: '{}',
		}));

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: { type: 'unauthorized' } });
	});

	it('reads GitHub webhook secrets from the runtime env argument', async () => {
		const body = JSON.stringify({ action: 'opened' });
		const handler = createGitHubWebhook();

		await expect(handler.receive(new Request('http://localhost/channels/github', {
			method: 'POST',
			headers: {
				'x-github-delivery': 'delivery-1',
				'x-github-event': 'issues',
				'x-hub-signature-256': await signature('secret', body),
			},
			body,
		}), { GITHUB_WEBHOOK_SECRET: 'secret' })).resolves.toMatchObject({ id: 'delivery-1' });
	});

	it('dispatches from a GitHub delivery through the configured queue', async () => {
		const dispatches: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			dispatchQueue: new InMemoryDispatchQueue({
				process(input) {
					dispatches.push(input);
				},
			}),
			receiveHandlers: {
				triage: async ({ delivery, dispatch }) => {
					await dispatch({ id: 'repo:flue/test', session: `issue:${(delivery.data as any).payload.issue.number}`, input: { type: 'github.issue', delivery } });
				},
			},
			manifest: {
				agents: [{ name: 'triage', channels: { github: true }, receive: true, created: true }],
			},
		});

		const app = new Hono();
		app.route('/', flue());
		app.route('/webhooks/github', createGitHubChannelRouter());
		const res = await app.fetch(new Request('http://localhost/webhooks/github', {
			method: 'POST',
			headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' },
			body: JSON.stringify({ action: 'opened', issue: { number: 123 }, repository: { full_name: 'flue/test' } }),
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(res.status).toBe(202);
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			deliveryId: 'delivery-1',
			sourceAgent: 'triage',
			targetAgent: 'triage',
			id: 'repo:flue/test',
			session: 'issue:123',
		});
	});
});

async function signature(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
