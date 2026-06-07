import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createCloudflareViteConfig,
} from '../../cli/src/lib/build.ts';

describe('Cloudflare extensions', () => {
	it('runs inherited scheduled callbacks when an agent module extends its base class', async () => {
		const root = await createGeneratedFixture();
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			server = await startServer(root);
			const { url } = server;
			await waitFor(async () => {
				const response = await fetch(new URL('/heartbeat', url));
				if (!response.ok) return { done: false, detail: await response.text() };
				const detail = (await response.json()) as { count: number };
				return { done: detail.count > 0, detail };
			});
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('routes mounted agent requests without deriving paths from Durable Object binding names', async () => {
		const root = await createGeneratedFixture(defaultAgentSource, '/api');
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			server = await startServer(root);
			const response = await fetch(new URL('/api/agents/assistant/mounted', server.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt: 'Hello' }),
			});
			expect(response.status).not.toBe(404);
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('wraps the final generated class without bypassing Flue-owned fetch handling', async () => {
		const root = await createGeneratedFixture();
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			server = await startServer(root);
			const response = await fetch(new URL('/agents/assistant/wrapped', server.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt: 'Hello' }),
			});
			expect(response.status).not.toBe(500);
			const heartbeat = await fetch(new URL('/heartbeat', server.url));
			expect(heartbeat.status).toBe(200);
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('wraps the final generated workflow class without bypassing Flue-owned request handling', async () => {
		const root = await createGeneratedFixture(defaultAgentSource, '', defaultWorkflowSource);
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		try {
			server = await startServer(root);
			const response = await fetch(new URL('/workflows/reviewer', server.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(202);
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);
});

async function createGeneratedFixture(
	agentSource = defaultAgentSource,
	mount = '',
	workflowSource?: string,
): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cloudflare-extension-'));
	const output = path.join(root, 'generated');
	fs.mkdirSync(path.join(root, 'node_modules', '@earendil-works'), { recursive: true });
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(
		path.resolve(process.cwd(), 'node_modules', '@earendil-works', 'pi-ai'),
		path.join(root, 'node_modules', '@earendil-works', 'pi-ai'),
		'dir',
	);
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	fs.symlinkSync(
		path.resolve(process.cwd(), '../../examples/cloudflare-websocket/node_modules/agents'),
		path.join(root, 'node_modules', 'agents'),
		'dir',
	);
	fs.mkdirSync(path.join(root, 'src', 'agents'), { recursive: true });
	if (workflowSource) fs.mkdirSync(path.join(root, 'src', 'workflows'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'wrangler.jsonc'),
		JSON.stringify({
			name: 'cloudflare-extension',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			migrations: [
				{
					tag: 'v1',
					new_sqlite_classes: [
						'FlueAssistantAgent',
						...(workflowSource ? ['FlueReviewerWorkflow'] : []),
						'FlueRegistry',
					],
				},
			],
		}),
	);
	fs.writeFileSync(path.join(root, 'src', 'agents', 'assistant.ts'), agentSource);
	if (workflowSource) {
		fs.writeFileSync(path.join(root, 'src', 'workflows', 'reviewer.ts'), workflowSource);
	}
	fs.writeFileSync(
		path.join(root, 'src', 'app.ts'),
		`import { Hono } from 'hono';\nimport { getAgentByName } from 'agents';\nimport { flue } from '@flue/runtime/routing';\nlet started = false;\nconst app = new Hono();\napp.route('${mount}', flue());\napp.get('${mount}/heartbeat', async (c) => {\n  const agent = await getAgentByName(c.env.FLUE_ASSISTANT_AGENT, 'scheduled');\n  if (!started) { await agent.startHeartbeat(); started = true; }\n  return c.json({ count: await agent.getHeartbeatCount() });\n});\nexport default app;\n`,
	);
	try {
		await build({
			root,
			sourceRoot: path.join(root, 'src'),
			output,
			target: 'cloudflare',
			mode: 'development',
		});
		return root;
	} catch (error) {
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

async function startServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
	const entryPath = path.join(cloudflareViteInputDir(root), '_entry.ts');
	const viteConfig = createCloudflareViteConfig(root, cloudflareViteConfigPath(root), [entryPath], {
		persistState: false,
	});
	const server: ViteDevServer = await createServer({
		...viteConfig,
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0 },
	});
	try {
		await server.listen();
		const url = server.resolvedUrls?.local[0];
		if (!url) throw new Error('Vite server URL unavailable');
		return { url, close: () => server.close() };
	} catch (error) {
		await server.close();
		throw error;
	}
}

async function waitFor(
	predicate: () => Promise<{ done: boolean; detail: unknown }>,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	let detail: unknown;
	while (Date.now() < deadline) {
		const result = await predicate();
		detail = result.detail;
		if (result.done) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`Timed out waiting for scheduled Cloudflare agent callback: ${JSON.stringify(detail)}`,
	);
}

const defaultAgentSource = `import { createAgent } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';
export default createAgent(() => ({ model: false }));
export const route = async (_c, next) => next();
export const cloudflare = extend({
  base: (Base) => class extends Base {
    async startHeartbeat() { return this.scheduleEvery(1, 'heartbeat'); }
    async heartbeat() { this.setState({ count: (this.state?.count ?? 0) + 1 }); }
    getHeartbeatCount() { return this.state?.count ?? 0; }
  },
  wrap: (Final) => new Proxy(Final, {
    construct(target, args) {
      if (target.name !== 'FlueAssistantAgent') throw new Error('wrapper did not receive stable agent class identity');
      for (const method of ['onRequest', 'fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'onFiberRecovered']) {
        if (!Object.prototype.hasOwnProperty.call(target.prototype, method)) {
          throw new Error('wrapper did not receive generated Flue class');
        }
      }
      return new target(...args);
    },
  }),
});
`;

const defaultWorkflowSource = `import { extend } from '@flue/runtime/cloudflare';
export async function run() { return { ok: true }; }
export const route = async (_c, next) => next();
export const cloudflare = extend({
  wrap: (Final) => new Proxy(Final, {
    construct(target, args) {
      if (target.name !== 'FlueReviewerWorkflow') throw new Error('wrapper did not receive stable workflow class identity');
      for (const method of ['onRequest', 'fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'onFiberRecovered']) {
        if (!Object.prototype.hasOwnProperty.call(target.prototype, method)) {
          throw new Error('wrapper did not receive generated Flue workflow class');
        }
      }
      return new target(...args);
    },
  }),
});
`;
