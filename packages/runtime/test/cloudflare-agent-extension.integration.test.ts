import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createCloudflareViteConfig,
} from '../../cli/src/lib/build.ts';

describe('Cloudflare agent extension', () => {
	it('rejects Cloudflare builds below the audited Agents SDK durability floor', async () => {
		const root = createAgentsFloorFixture('0.14.0');
		try {
			await expect(
				build({ root, sourceRoot: path.join(root, 'src'), target: 'cloudflare', mode: 'development' }),
			).rejects.toThrow(
				'[flue] Cloudflare target requires the installed "agents" package to satisfy >=0.14.1 <0.15.0. Found 0.14.0. Install a compatible "agents" version in this project.',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('accepts the audited Agents SDK durability floor for Cloudflare builds', async () => {
		const root = createAgentsFloorFixture('0.14.1');
		try {
			await expect(
				build({ root, sourceRoot: path.join(root, 'src'), target: 'cloudflare', mode: 'development' }),
			).rejects.toThrow('[flue] No agent or workflow files found.');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it('does not apply the Agents SDK durability floor to Node builds', async () => {
		const root = createAgentsFloorFixture('0.14.0');
		try {
			await expect(
				build({ root, sourceRoot: path.join(root, 'src'), target: 'node' }),
			).rejects.toThrow('[flue] No agent or workflow files found.');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

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
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { type: 'invalid_request' } });
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
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { type: 'invalid_request' } });
			const heartbeat = await fetch(new URL('/heartbeat', server.url));
			expect(heartbeat.status).toBe(200);
		} finally {
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);

	it('routes named generated Durable Objects across dispatch, workflow, and WebSocket transports', async () => {
		const root = await createGeneratedFixture(defaultAgentSource, '', true);
		let server: Awaited<ReturnType<typeof startServer>> | undefined;
		let agentSocket: WebSocket | undefined;
		let workflowSocket: WebSocket | undefined;
		try {
			server = await startServer(root);
			const agentSocketUrl = new URL('/agents/assistant/socket-instance', server.url);
			agentSocketUrl.protocol = 'ws:';
			agentSocket = new WebSocket(agentSocketUrl.toString());
			const agentFirstMessage = await waitForSocketMessage(agentSocket);
			expect(JSON.parse(agentFirstMessage)).toMatchObject({
				version: 1,
				type: 'ready',
				target: 'agent',
				name: 'assistant',
				instanceId: 'socket-instance',
			});

			const dispatchResponse = await fetch(new URL('/dispatch', server.url));
			const dispatchBody = await dispatchResponse.text();
			expect(dispatchResponse.status, dispatchBody).toBe(200);
			expect(JSON.parse(dispatchBody)).toEqual({
				dispatchId: expect.any(String),
				acceptedAt: expect.any(String),
			});

			const workflowResponse = await fetch(new URL('/workflows/smoke?wait=result', server.url), {
				method: 'POST',
			});
			const workflowBody = await workflowResponse.text();
			expect(workflowResponse.status, workflowBody).toBe(200);
			expect(JSON.parse(workflowBody)).toEqual({
				result: { ok: true },
				_meta: { runId: expect.any(String) },
			});

			const workflowSocketUrl = new URL('/workflows/smoke', server.url);
			workflowSocketUrl.protocol = 'ws:';
			workflowSocket = new WebSocket(workflowSocketUrl.toString());
			const workflowFirstMessage = await waitForSocketMessage(workflowSocket);
			expect(JSON.parse(workflowFirstMessage)).toEqual({
				version: 1,
				type: 'ready',
				target: 'workflow',
				name: 'smoke',
			});
		} finally {
			agentSocket?.close();
			workflowSocket?.close();
			await server?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90000);
});

function createAgentsFloorFixture(version: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cloudflare-agents-floor-'));
	fs.mkdirSync(path.join(root, 'node_modules', 'agents'), { recursive: true });
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'node_modules', 'agents', 'package.json'),
		JSON.stringify({ name: 'agents', version, main: 'index.js' }),
	);
	fs.writeFileSync(path.join(root, 'node_modules', 'agents', 'index.js'), 'module.exports = {};\n');
	return root;
}

async function createGeneratedFixture(
	agentSource = defaultAgentSource,
	mount = '',
	withWorkflow = false,
): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-cloudflare-agent-extension-'));
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
	if (withWorkflow) fs.mkdirSync(path.join(root, 'src', 'workflows'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'wrangler.jsonc'),
		JSON.stringify({
			name: 'cloudflare-agent-extension',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			migrations: [
				{
					tag: 'v1',
					new_sqlite_classes: [
						'FlueAssistantAgent',
						...(withWorkflow ? ['FlueSmokeWorkflow'] : []),
						'FlueRegistry',
					],
				},
			],
		}),
	);
	fs.writeFileSync(path.join(root, 'src', 'agents', 'assistant.ts'), agentSource);
	if (withWorkflow) {
		fs.writeFileSync(
			path.join(root, 'src', 'workflows', 'smoke.ts'),
			`export const route = async (_c, next) => next();\nexport const websocket = async (_c, next) => next();\nexport async function run() { return { ok: true }; }\n`,
		);
	}
	fs.writeFileSync(
		path.join(root, 'src', 'app.ts'),
		`import { Hono } from 'hono';\nimport { getAgentByName } from 'agents';\nimport { dispatch } from '@flue/runtime';\nimport { flue } from '@flue/runtime/routing';\nlet started = false;\nconst app = new Hono();\napp.route('${mount}', flue());\napp.get('${mount}/heartbeat', async (c) => {\n  const agent = await getAgentByName(c.env.FLUE_ASSISTANT_AGENT, 'scheduled');\n  if (!started) { await agent.startHeartbeat(); started = true; }\n  return c.json({ count: await agent.getHeartbeatCount() });\n});\napp.get('${mount}/dispatch', async (c) => c.json(await dispatch({ agent: 'assistant', id: 'dispatched', input: { text: 'Hello' } })));\nexport default app;\n`,
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

async function waitForSocketMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message.')), 10_000);
		socket.once('message', (data) => {
			clearTimeout(timeout);
			resolve(data.toString());
		});
		socket.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
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
export const websocket = async (_c, next) => next();
export const cloudflare = extend({
  base: (Base) => class extends Base {
    async startHeartbeat() { return this.scheduleEvery(1, 'heartbeat'); }
    async heartbeat() { this.setState({ count: (this.state?.count ?? 0) + 1 }); }
    getHeartbeatCount() { return this.state?.count ?? 0; }
  },
  wrap: (Final) => new Proxy(Final, {
    construct(target, args) {
      if (target.name !== 'FlueAssistantAgent') throw new Error('wrapper did not receive stable agent class identity');
      for (const method of ['onStart', '__flueWakeAgentSubmissions', 'onRequest', 'fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'onFiberRecovered']) {
        if (!Object.prototype.hasOwnProperty.call(target.prototype, method)) {
          throw new Error('wrapper did not receive generated Flue class');
        }
      }
      return new target(...args);
    },
  }),
});
`;
