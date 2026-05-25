import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin, ViteNodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

describe('Node build plugin', () => {
	it('derives route metadata from imported agent and workflow modules', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain("import * as handler_triage_0 from '/tmp/triage.ts'");
		expect(entry).toContain("import * as workflow_daily_report_0 from '/tmp/daily-report.ts'");
		expect(entry).toContain("import * as channel_slack_0 from '/tmp/slack.ts'");
		expect(entry).toContain('const workflowHandlers = {};');
		expect(entry).toContain('const websocketAgentHandlers = {};');
		expect(entry).toContain('const websocketWorkflowHandlers = {};');
		expect(entry).toContain('const agentRouteMiddleware = {};');
		expect(entry).toContain('const workflowWebSocketMiddleware = {};');
		expect(entry).toContain('const dispatchAgentNames = new Map();');
		expect(entry).toContain('dispatchAgentNames.set(mod.default, name);');
		expect(entry).toContain('resolveDispatchAgentName: (agent) => dispatchAgentNames.get(agent),');
		expect(entry).toContain('const channelModules = {');
		expect(entry).toContain('const normalized = normalizeBuiltModules(agentModules, workflowModules, channelModules);');
		expect(entry).toContain('channelApps,');
		const dispatchQueueBody = entry.slice(entry.indexOf('const dispatchQueue ='), entry.indexOf('function createContextForRequest'));
		expect(dispatchQueueBody).not.toContain('runStore');
		expect(dispatchQueueBody).not.toContain('runSubscribers');
		expect(dispatchQueueBody).not.toContain('runRegistry');
	});

	it('builds and starts a Vite Node server with existing workflow behavior', async () => {
		const root = createFixtureRoot('flue-vite-node-server-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`import { http } from '@flue/runtime';\nexport const channels = [http()];\nexport async function run() { return { ok: true }; }\n`,
		);
		await build({ root, plugin: new ViteNodePlugin() });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/smoke?wait=result`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	}, 15000);

	it('builds imported Agent Skills as references through the Vite Node graph', async () => {
		const root = createFixtureRoot('flue-vite-node-skill-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'skills', 'review', 'references'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'skills', 'review', 'SKILL.md'),
			`---\nname: review\ndescription: Reviews requested work.\nlicense: LICENSE.txt\n---\nReview the request.\n`,
		);
		fs.writeFileSync(path.join(root, 'skills', 'review', 'LICENSE.txt'), 'License terms.\n');
		fs.writeFileSync(path.join(root, 'skills', 'review', 'references', 'checklist.md'), 'Check the result.\n');
		fs.writeFileSync(
			path.join(root, 'workflows', 'inspect.ts'),
			`import { http } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const channels = [http()];\nexport async function run() { return { reference: review, hasBody: 'body' in review, hasFiles: 'files' in review }; }\n`,
		);
		await build({ root, plugin: new ViteNodePlugin() });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/inspect?wait=result`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: {
					reference: { __flueSkillReference: true, name: 'review', description: 'Reviews requested work.' },
					hasBody: false,
					hasFiles: false,
				},
			});
		} finally {
			child.kill('SIGTERM');
		}
	}, 15000);

	it('starts a generated server and invokes an HTTP workflow', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-server-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
		fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`import { http } from '@flue/runtime';\n` +
				`export const channels = [http()];\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const port = await findAvailablePort();
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
		});
		try {
			await waitForServer(child, port);
			const response = await fetch(`http://localhost:${port}/workflows/smoke?wait=result`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('exposes and wraps an HTTP workflow through its route export', async () => {
		const root = createFixtureRoot('flue-route-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'protected-job.ts'),
			`export const route = async (c, next) => { if (c.req.header('authorization') !== 'Bearer allowed') return c.text('Unauthorized', 401); await next(); c.header('x-route', 'yes'); };\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const rejected = await fetch(`http://localhost:${port}/workflows/protected-job?wait=result`, { method: 'POST' });
			expect(rejected.status).toBe(401);
			const allowed = await fetch(`http://localhost:${port}/workflows/protected-job?wait=result`, {
				method: 'POST',
				headers: { authorization: 'Bearer allowed' },
			});
			expect(allowed.status).toBe(200);
			expect(allowed.headers.get('x-route')).toBe('yes');
			expect(await allowed.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('mounts discovered channel applications with registered agent listeners', async () => {
		const root = createFixtureRoot('flue-mounted-channel-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'channels'));
		fs.writeFileSync(
			path.join(root, 'channels', 'events.ts'),
			`import { Hono } from 'hono';\n` +
				`import { defineChannel } from '@flue/runtime';\n` +
				`const app = new Hono();\n` +
				`const channel = defineChannel({ app });\n` +
				`app.post('/emit', async (c) => c.json(await channel.emit('message', { event: { text: 'hello' }, thread: { id: 'one' } })));\n` +
				`export default channel;\n`,
		);
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`import events from '../channels/events.ts';\n` +
				`events.on('message', async () => {});\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/channels/events/emit`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ invoked: 1, errors: [] });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('mounts discovered channel applications below custom app prefixes', async () => {
		const root = createFixtureRoot('flue-prefixed-channel-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'channels'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `import { createAgent } from '@flue/runtime';\nexport default createAgent(() => ({ model: false }));\n`);
		fs.writeFileSync(
			path.join(root, 'channels', 'hooks.ts'),
			`import { Hono } from 'hono';\nimport { defineChannel } from '@flue/runtime';\nconst app = new Hono();\napp.get('/health', (c) => c.text('ok'));\nexport default defineChannel({ app });\n`,
		);
		fs.writeFileSync(path.join(root, 'app.ts'), `import { Hono } from 'hono';\nimport { flue } from '@flue/runtime/app';\nconst app = new Hono();\napp.route('/api', flue());\nexport default app;\n`);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/api/channels/hooks/health`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('ok');
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('exposes an agent HTTP endpoint through its route export', async () => {
		const root = createFixtureRoot('flue-route-agent-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`export const route = async (c) => c.text('Blocked', 403);\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/agents/assistant/instance-1`, { method: 'POST' });
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('Blocked');
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('dispatches from a workflow to a discovered created agent by reference', async () => {
		const root = createFixtureRoot('flue-global-dispatch-workflow-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'workflows', 'notify.ts'),
			`import { dispatch } from '@flue/runtime';\n` +
				`import assistant from '../agents/assistant.ts';\n` +
				`export const route = async (c, next) => { await next(); };\n` +
				`export async function run() { const receipt = await dispatch(assistant, { id: 'thread-1', input: { text: 'hello' } }); return { accepted: typeof receipt.dispatchId === 'string' }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/notify?wait=result`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { accepted: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('invokes a WebSocket-exported workflow without exposing HTTP POST', async () => {
		const root = createFixtureRoot('flue-exported-websocket-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'socket-job.ts'),
			`export const websocket = async (c, next) => { if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401); await next(); };\n` +
				`export async function run(ctx) { return { echoed: ctx.payload }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/workflows/socket-job`, { method: 'POST' });
			expect(http.status).toBe(404);
			const rejected = new WebSocket(`ws://localhost:${port}/workflows/socket-job`);
			expect(await waitForSocketFailure(rejected)).toBe(true);
			const socket = new WebSocket(`ws://localhost:${port}/workflows/socket-job?token=ok`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'req-1', payload: { ok: true } }));
			const result = await waitForMessage(messages, (message) => message.type === 'result');
			expect(result).toMatchObject({ type: 'result', requestId: 'req-1', result: { echoed: { ok: true } } });
			await waitForClose(socket);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('invokes a WebSocket-only workflow without exposing HTTP POST', async () => {
		const root = createFixtureRoot('flue-websocket-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'socket-job.ts'),
			`import { websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export async function run(ctx) { ctx.log.info('socket run'); return { echoed: ctx.payload }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/workflows/socket-job`, { method: 'POST' });
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/workflows/socket-job`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'req-1', payload: { ok: true } }));
			const result = await waitForMessage(messages, (message) => message.type === 'result');
			expect(result).toMatchObject({ type: 'result', requestId: 'req-1', result: { echoed: { ok: true } } });
			expect(messages.some((message) => message.type === 'ready')).toBe(true);
			expect(messages.some((message) => message.type === 'started')).toBe(true);
			expect(messages.some((message) => message.type === 'event' && message.event.type === 'run_start')).toBe(true);
			await waitForClose(socket);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects WebSocket upgrades for HTTP-only workflows', async () => {
		const root = createFixtureRoot('flue-http-only-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'http-job.ts'),
			`import { http } from '@flue/runtime';\n` +
				`export const channels = [http()];\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const socket = new WebSocket(`ws://localhost:${port}/workflows/http-job`);
			const failure = await waitForSocketFailure(socket);
			expect(failure).toBe(true);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('accepts agent WebSocket connections and ping frames independently of HTTP', async () => {
		const root = createFixtureRoot('flue-websocket-agent-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent, websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/agents/assistant/instance-1`, { method: 'POST' });
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/agents/assistant/instance-1`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			const ready = await waitForMessage(messages, (message) => message.type === 'ready');
			expect(ready).toMatchObject({ type: 'ready', target: 'agent', name: 'assistant', instanceId: 'instance-1' });
			socket.send(JSON.stringify({ version: 1, type: 'ping', requestId: 'ping-1' }));
			const pong = await waitForMessage(messages, (message) => message.type === 'pong');
			expect(pong).toMatchObject({ type: 'pong', requestId: 'ping-1' });
			socket.close();
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('routes mounted custom-app WebSockets through middleware', async () => {
		const root = createFixtureRoot('flue-custom-app-websocket-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent, websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'app.ts'),
			`import { flue } from '@flue/runtime/app';\n` +
				`import { Hono } from 'hono';\n` +
				`const app = new Hono();\n` +
				`app.use('/api/agents/*', async (c, next) => { if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401); await next(); });\n` +
				`app.route('/api', flue());\n` +
				`export default app;\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const rejected = new WebSocket(`ws://localhost:${port}/api/agents/assistant/instance-1`);
			expect(await waitForSocketFailure(rejected)).toBe(true);
			const socket = new WebSocket(`ws://localhost:${port}/api/agents/assistant/instance-1?token=ok`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			const ready = await waitForMessage(messages, (message) => message.type === 'ready');
			expect(ready).toMatchObject({ target: 'agent', name: 'assistant', instanceId: 'instance-1' });
			socket.close();
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects duplicate agent basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-duplicate-agents-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), 'export default createAgent(() => ({ model: false }));\n');
		fs.writeFileSync(path.join(root, 'agents', 'assistant.js'), 'export default createAgent(() => ({ model: false }));\n');

		await expect(build({ root, target: 'node' })).rejects.toThrow('Duplicate agent basename "assistant"');
	});

	it('loads workflow entrypoints exported through ordinary module syntax', async () => {
		const root = createFixtureRoot('flue-workflow-module-exports-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'draft.ts'),
			`import { http } from '@flue/runtime';\n` +
				`const channels = [http()];\n` +
				`const run = async () => ({ ok: true });\n` +
				`export { channels, run };\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/draft?wait=result`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects shared created-agent identities for reference-based dispatch', async () => {
		const root = createFixtureRoot('flue-shared-agent-identity-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'shared.ts'),
			`import { createAgent } from '@flue/runtime';\nexport default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(path.join(root, 'agents', 'first.ts'), `export { default } from '../shared.ts';\n`);
		fs.writeFileSync(path.join(root, 'agents', 'second.ts'), `export { default } from '../shared.ts';\n`);
		await build({ root, target: 'node' });

		const port = await findAvailablePort();
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
		});
		try {
			const stderr = await waitForProcessExit(child);
			expect(stderr).toContain('default-export the same created agent value');
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
		}
	});

	it('rejects unsupported attached-channel markers on agents', async () => {
		const root = createFixtureRoot('flue-agent-invalid-channel-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`export const channels = [{ __flueChannel: true, name: 'incoming' }];\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, target: 'node' });

		const port = await findAvailablePort();
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
		});
		try {
			const output = await waitForProcessExit(child);
			expect(output).toContain('Only http() and websocket() are supported.');
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
		}
	});
});

function createFixtureRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	return root;
}

async function startGeneratedServer(root: string): Promise<{ child: ChildProcess; port: number }> {
	const port = await findAvailablePort();
	const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
	});
	await waitForServer(child, port);
	return { child, port };
}

function collectMessages(socket: WebSocket): WebSocketServerMessage[] {
	const messages: WebSocketServerMessage[] = [];
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as WebSocketServerMessage);
	});
	return messages;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) return;
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), { once: true });
	});
}

async function waitForClose(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
}

async function waitForSocketFailure(socket: WebSocket): Promise<boolean> {
	return new Promise((resolve) => {
		socket.addEventListener('open', () => resolve(false), { once: true });
		socket.addEventListener('error', () => resolve(true), { once: true });
	});
}

async function waitForProcessExit(child: ChildProcess): Promise<string> {
	let output = '';
	child.stderr?.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stdout?.on('data', (chunk) => {
		output += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		child.once('exit', () => resolve());
		child.once('error', reject);
	});
	return output;
}

async function waitForMessage(
	messages: WebSocketServerMessage[],
	predicate: (message: WebSocketServerMessage) => boolean,
): Promise<WebSocketServerMessage> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const found = messages.find(predicate);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}

async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				server.close(() => resolve(address.port));
				return;
			}
			server.close(() => reject(new Error('Could not determine port')));
		});
		server.on('error', reject);
	});
}

async function waitForServer(child: ChildProcess, port: number): Promise<void> {
	let output = '';
	child.stderr?.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stdout?.on('data', (chunk) => {
		output += chunk.toString();
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (child.exitCode !== null) {
			throw new Error(`Generated server exited before listening:\n${output}`);
		}
		try {
			const response = await fetch(`http://localhost:${port}/runs/not-found`);
			await response.text();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Generated server did not begin listening:\n${output}`);
}

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'triage', filePath: '/tmp/triage.ts' }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts' }],
		channels: [{ name: 'slack', filePath: '/tmp/slack.ts' }],
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'node' },
	};
}
