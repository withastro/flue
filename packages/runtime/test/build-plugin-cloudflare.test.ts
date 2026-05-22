import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';
import { flue } from '../src/app.ts';
import { createGitHubWebhook } from '../src/github.ts';
import { configureFlueRuntime } from '../src/internal.ts';

describe('Cloudflare build plugin', () => {
	it('fails external-channel dispatch processing clearly instead of using memory fallback', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('Cloudflare external-channel dispatch processing is not supported yet');
		expect(entry).toContain('Dispatch must route to the target agent Durable Object');
		expect(entry).not.toContain('createAgentDispatchProcessor');
		expect(entry).not.toContain('createContextForRequest(id, runId, payload, undefined, req)');
	});

	it('rejects Cloudflare external-channel requests before unsupported dispatch admission', async () => {
		configureFlueRuntime({
			target: 'cloudflare',
			channelHandlers: { github: createGitHubWebhook() },
			manifest: {
				agents: [{ name: 'moderator', channels: { github: true }, receive: true, init: true }],
			},
		});

		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(new Request('http://localhost/channels/github', {
			method: 'POST',
			headers: { 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' },
			body: '{}',
		}));

		expect(res.status).toBe(501);
		expect(await res.json()).toMatchObject({ error: { type: 'external_channel_unavailable' } });
	});
});

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'moderator', filePath: '/tmp/moderator.ts', channels: { discord: true }, hasReceive: true, hasInit: true }],
		workflows: [],
		manifest: {
			agents: [{ name: 'moderator', channels: { discord: true }, receive: true, init: true }],
			workflows: [],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'cloudflare' },
	};
}
