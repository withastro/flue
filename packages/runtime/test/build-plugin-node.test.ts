import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

describe('Node build plugin', () => {
	it('derives route metadata from imported agent and workflow modules', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain("import * as handler_triage_0 from '/tmp/triage.ts'");
		expect(entry).toContain("import * as workflow_daily_report_0 from '/tmp/daily-report.ts'");
		expect(entry).toContain("import { getPackagedSkills } from 'virtual:flue/packaged-skills';");
		expect(entry).toContain('const packagedSkills = getPackagedSkills();');
		expect(entry).toContain('Bash,\n  InMemoryFs,\n  createFlueContext,');
		expect(entry).not.toContain("from 'just-bash'");
		expect(entry).toContain('const workflowHandlers = {};');
		expect(entry).toContain('const localWorkflowHandlers = {};');
		expect(entry).toContain('const localAgentHandlers = {};');
		expect(entry).toContain('const websocketAgentHandlers = {};');
		expect(entry).toContain('const websocketWorkflowHandlers = {};');
		expect(entry).toContain('const agentRouteMiddleware = {};');
		expect(entry).toContain('const workflowWebSocketMiddleware = {};');
		expect(entry).toContain('const dispatchAgentNames = new Map();');
		expect(entry).toContain('dispatchAgentNames.set(mod.default, name);');
		expect(entry).toContain('resolveDispatchAgentName: (agent) => dispatchAgentNames.get(agent),');
		expect(entry).toContain('devMode: isLocalMode,');
		expect(entry).toContain(
			'const normalized = normalizeBuiltModules(agentModules, workflowModules);',
		);
		const dispatchQueueBody = entry.slice(
			entry.indexOf('const dispatchQueue ='),
			entry.indexOf('function createContextForRequest'),
		);
		expect(dispatchQueueBody).not.toContain('runStore');
		expect(dispatchQueueBody).not.toContain('runSubscribers');
		expect(dispatchQueueBody).not.toContain('runRegistry');
	});

	it('injects the public Pi Bedrock provider module when configured', () => {
		const entry = new NodePlugin().generateEntryPoint({
			...testBuildContext(),
			options: {
				...testBuildContext().options,
				providers: ['amazon-bedrock'],
			},
		});

		expect(entry).toContain("import '@flue/runtime/node/bedrock';");
	});

	it('builds and starts a Node server through the production Vite graph', async () => {
		const root = createFixtureRoot('flue-vite-node-server-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`export const route = async (_c, next) => next();\nexport async function run() { return { ok: true }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/smoke?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	}, 15000);

	it('bundles the AWS SDK when Amazon Bedrock is configured', async () => {
		const root = createFixtureRoot('flue-vite-node-bedrock-provider-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`export const route = async (_c, next) => next();\nexport async function run() { return { ok: true }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node', providers: ['amazon-bedrock'] });
		const emittedJavaScript = readEmittedJavaScript(path.join(root, 'dist'));
		expect(emittedJavaScript).toContain('BedrockRuntimeClient');
		expect(emittedJavaScript).not.toContain('importNodeOnlyProvider("./amazon-bedrock.ts")');
	}, 15000);

	it('reports when a built-in provider was not included in the build', async () => {
		const root = createFixtureRoot('flue-vite-node-provider-allowlist-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'prompt.ts'),
			`import { createAgent, type FlueContext } from '@flue/runtime';\nexport const route = async (_c, next) => next();\nconst agent = createAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));\nexport async function run({ init }: FlueContext) { const harness = await init(agent); const session = await harness.session(); return session.prompt('hello'); }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });
		const emittedJavaScript = readEmittedJavaScript(path.join(root, 'dist'));
		expect(emittedJavaScript).toContain('is not included in this build. Add "anthropic"');
		expect(emittedJavaScript).toContain('to providers in flue.config.ts.');

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/prompt?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: { type: 'internal_error' } });
		} finally {
			child.kill('SIGTERM');
		}
	}, 15000);

	it('recommends a built-in transport when a custom provider transport was omitted', async () => {
		const root = createFixtureRoot('flue-vite-node-custom-provider-allowlist-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'prompt.ts'),
			`import { createAgent, registerProvider, type FlueContext } from '@flue/runtime';\nregisterProvider('ollama', { api: 'openai-completions', baseUrl: 'http://localhost:11434/v1' });\nexport const route = async (_c, next) => next();\nconst agent = createAgent(() => ({ model: 'ollama/llama3.1:8b' }));\nexport async function run({ init }: FlueContext) { const harness = await init(agent); const session = await harness.session(); return session.prompt('hello'); }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });
		const emittedJavaScript = readEmittedJavaScript(path.join(root, 'dist'));
		expect(emittedJavaScript).toContain('is not included in this build. Add "openai"');
	}, 15000);

	it('builds attributed Markdown imports as text through the production Node graph', async () => {
		const root = createFixtureRoot('flue-vite-node-markdown-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'instructions'));
		fs.writeFileSync(
			path.join(root, 'instructions', 'proposal.md'),
			'# Proposal\n\nWrite carefully.\n',
		);
		fs.writeFileSync(
			path.join(root, 'workflows', 'inspect.ts'),
			`import instructions from '../instructions/proposal.md' with { type: 'markdown' };\nexport const route = async (_c, next) => next();\nexport async function run() { return { instructions }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/inspect?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: { instructions: '# Proposal\n\nWrite carefully.\n' },
			});
		} finally {
			child.kill('SIGTERM');
		}
	}, 15000);

	it('builds imported Agent Skills as references through the production Node graph', async () => {
		const root = createFixtureRoot('flue-vite-node-skill-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'skills', 'review', 'references'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'skills', 'review', 'SKILL.md'),
			`---\nname: review\ndescription: Reviews requested work.\nlicense: LICENSE.txt\n---\nReview the request.\n`,
		);
		fs.writeFileSync(path.join(root, 'skills', 'review', 'LICENSE.txt'), 'License terms.\n');
		fs.writeFileSync(
			path.join(root, 'skills', 'review', 'references', 'checklist.md'),
			'Check the result.\n',
		);
		fs.writeFileSync(
			path.join(root, 'workflows', 'inspect.ts'),
			`import review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const route = async (_c, next) => next();\nexport async function run() { return { reference: review, hasBody: 'body' in review, hasFiles: 'files' in review }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/inspect?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: {
					reference: {
						__flueSkillReference: true,
						name: 'review',
						description: 'Reviews requested work.',
					},
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
			`export const route = async (_c, next) => next();\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

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
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const rejected = await fetch(`http://localhost:${port}/workflows/protected-job?wait=result`, {
				method: 'POST',
			});
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

	it('exposes an agent HTTP endpoint through its route export', async () => {
		const root = createFixtureRoot('flue-route-agent-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`export const route = async (c) => c.text('Blocked', 403);\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/agents/assistant/instance-1`, {
				method: 'POST',
			});
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
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/notify?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { accepted: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('dispatches from custom app routing through the canonical runtime export', async () => {
		const root = createFixtureRoot('flue-global-dispatch-app-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'app.ts'),
			`import { Hono } from 'hono';\n` +
				`import { dispatch } from '@flue/runtime';\n` +
				`import { flue } from '@flue/runtime/routing';\n` +
				`import assistant from './agents/assistant.ts';\n` +
				`const app = new Hono();\n` +
				`app.post('/enqueue', async (c) => c.json(await dispatch(assistant, { id: 'thread-1', input: { text: 'hello' } })));\n` +
				`app.route('/', flue());\n` +
				`export default app;\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/enqueue`, { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				dispatchId: expect.any(String),
				acceptedAt: expect.any(String),
			});
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('preserves authored app fetch receivers and forwards Node bindings', async () => {
		const root = createFixtureRoot('flue-custom-fetch-app-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'unused.ts'),
			`export async function run() { return null; }\n`,
		);
		fs.writeFileSync(
			path.join(root, 'app.ts'),
			`const app = {\n` +
				`  prefix: 'bound',\n` +
				`  fetch(_request: Request, env?: { incoming?: unknown; outgoing?: unknown }) {\n` +
				`    return Response.json({ prefix: this.prefix, hasIncoming: !!env?.incoming, hasOutgoing: !!env?.outgoing });\n` +
				`  },\n` +
				`};\n` +
				`export default app;\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				prefix: 'bound',
				hasIncoming: true,
				hasOutgoing: true,
			});
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
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/workflows/socket-job`, { method: 'POST' });
			expect(http.status).toBe(404);
			const rejected = new WebSocket(`ws://localhost:${port}/workflows/socket-job`);
			expect(await waitForSocketFailure(rejected)).toBe(true);
			const socket = new WebSocket(`ws://localhost:${port}/workflows/socket-job?token=ok`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			socket.send(
				JSON.stringify({ version: 1, type: 'invoke', requestId: 'req-1', payload: { ok: true } }),
			);
			const result = await waitForMessage(messages, (message) => message.type === 'result');
			expect(result).toMatchObject({
				type: 'result',
				requestId: 'req-1',
				result: { echoed: { ok: true } },
			});
			await waitForClose(socket);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('invokes a pass-through WebSocket-exported workflow without exposing HTTP POST', async () => {
		const root = createFixtureRoot('flue-websocket-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'socket-job.ts'),
			`export const websocket = async (_c, next) => next();\n` +
				`export async function run(ctx) { ctx.log.info('socket run'); return { echoed: ctx.payload }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/workflows/socket-job`, { method: 'POST' });
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/workflows/socket-job`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			socket.send(
				JSON.stringify({ version: 1, type: 'invoke', requestId: 'req-1', payload: { ok: true } }),
			);
			const result = await waitForMessage(messages, (message) => message.type === 'result');
			expect(result).toMatchObject({
				type: 'result',
				requestId: 'req-1',
				result: { echoed: { ok: true } },
			});
			expect(messages.some((message) => message.type === 'ready')).toBe(true);
			expect(messages.some((message) => message.type === 'started')).toBe(true);
			expect(
				messages.some((message) => message.type === 'event' && message.event.type === 'run_start'),
			).toBe(true);
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
			`export const route = async (_c, next) => next();\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

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
			`import { createAgent } from '@flue/runtime';\n` +
				`export const websocket = async (_c, next) => next();\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/agents/assistant/instance-1`, {
				method: 'POST',
			});
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/agents/assistant/instance-1`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			const ready = await waitForMessage(messages, (message) => message.type === 'ready');
			expect(ready).toMatchObject({
				type: 'ready',
				target: 'agent',
				name: 'assistant',
				instanceId: 'instance-1',
			});
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
			`import { createAgent } from '@flue/runtime';\n` +
				`export const websocket = async (_c, next) => next();\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'app.ts'),
			`import { flue } from '@flue/runtime/routing';\n` +
				`import { Hono } from 'hono';\n` +
				`const app = new Hono();\n` +
				`app.use('/api/agents/*', async (c, next) => { if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401); await next(); });\n` +
				`app.route('/api', flue());\n` +
				`export default app;\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const rejected = new WebSocket(`ws://localhost:${port}/api/agents/assistant/instance-1`);
			expect(await waitForSocketFailure(rejected)).toBe(true);
			const socket = new WebSocket(
				`ws://localhost:${port}/api/agents/assistant/instance-1?token=ok`,
			);
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
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			'export default createAgent(() => ({ model: false }));\n',
		);
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.js'),
			'export default createAgent(() => ({ model: false }));\n',
		);

		await expect(build({ root, sourceRoot: root, target: 'node' })).rejects.toThrow(
			'Duplicate agent basename "assistant"',
		);
	});

	it('invokes an internal-only workflow over local IPC without public HTTP exposure', async () => {
		const root = createFixtureRoot('flue-local-ipc-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'private-job.ts'),
			`export async function run(ctx) { return { payload: ctx.payload, url: ctx.req.url }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const child = startGeneratedIpcChild(root, {
			FLUE_CLI_TARGET: 'workflow',
			FLUE_CLI_NAME: 'private-job',
		});
		try {
			const ready = await waitForChildMessage(child, (message) => message.type === 'ready');
			expect(ready).toMatchObject({ type: 'ready', target: 'workflow', name: 'private-job' });
			child.send?.({ version: 1, type: 'invoke', requestId: 'req-ipc', payload: { ok: true } });
			const result = await waitForChildMessage(child, (message) => message.type === 'result');
			expect(result).toMatchObject({
				type: 'result',
				requestId: 'req-ipc',
				result: { payload: { ok: true }, url: 'http://flue.local/_cli' },
			});
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
		}

		const { child: server, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/private-job`, {
				method: 'POST',
			});
			expect(response.status).toBe(404);
		} finally {
			server.kill('SIGTERM');
		}
	});

	it('bypasses public workflow middleware during local IPC execution', async () => {
		const root = createFixtureRoot('flue-local-ipc-middleware-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'protected-job.ts'),
			`export const route = async (c) => c.text('Blocked', 403);\nexport async function run() { return { ok: true }; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const child = startGeneratedIpcChild(root, {
			FLUE_CLI_TARGET: 'workflow',
			FLUE_CLI_NAME: 'protected-job',
		});
		try {
			await waitForChildMessage(child, (message) => message.type === 'ready');
			child.send?.({ version: 1, type: 'invoke', requestId: 'req-protected' });
			const result = await waitForChildMessage(child, (message) => message.type === 'result');
			expect(result).toMatchObject({ type: 'result', result: { ok: true } });
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
		}

		const { child: server, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/protected-job?wait=result`, {
				method: 'POST',
			});
			expect(response.status).toBe(403);
		} finally {
			server.kill('SIGTERM');
		}
	});

	it('accepts local IPC prompts for a non-public agent and keeps the connection alive after errors', async () => {
		const root = createFixtureRoot('flue-local-ipc-agent-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent } from '@flue/runtime';\nexport default createAgent(({ id }) => ({ model: false, instructions: id }));\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const child = startGeneratedIpcChild(root, {
			FLUE_CLI_TARGET: 'agent',
			FLUE_CLI_NAME: 'assistant',
			FLUE_CLI_ID: 'thread-1',
		});
		try {
			const ready = await waitForChildMessage(child, (message) => message.type === 'ready');
			expect(ready).toMatchObject({
				type: 'ready',
				target: 'agent',
				name: 'assistant',
				instanceId: 'thread-1',
			});
			child.send?.({
				version: 1,
				type: 'prompt',
				requestId: 'req-agent',
				message: 'hello',
				session: 'support',
			});
			const error = await waitForChildMessage(
				child,
				(message) => message.type === 'error' && message.requestId === 'req-agent',
			);
			expect(error).toMatchObject({
				type: 'error',
				requestId: 'req-agent',
				error: { type: 'internal_error' },
			});
			child.send?.({ version: 1, type: 'ping', requestId: 'req-after-error' });
			const pong = await waitForChildMessage(child, (message) => message.type === 'pong');
			expect(pong).toMatchObject({ type: 'pong', requestId: 'req-after-error' });
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
		}
	});

	it('fails local CLI mode without an inherited IPC connection', async () => {
		const root = createFixtureRoot('flue-local-ipc-missing-connection-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'job.ts'),
			`export async function run() { return true; }\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				FLUE_MODE: 'local',
				FLUE_CLI_TARGET: 'workflow',
				FLUE_CLI_NAME: 'job',
			},
		});
		const output = await waitForProcessExit(child);
		expect(output).toContain('Local CLI execution requires an inherited IPC connection');
	});

	it('loads workflow entrypoints exported through ordinary module syntax', async () => {
		const root = createFixtureRoot('flue-workflow-module-exports-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'draft.ts'),
			`const route = async (_c, next) => next();\n` +
				`const run = async () => ({ ok: true });\n` +
				`export { route, run };\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const response = await fetch(`http://localhost:${port}/workflows/draft?wait=result`, {
				method: 'POST',
			});
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
		fs.writeFileSync(
			path.join(root, 'agents', 'first.ts'),
			`export { default } from '../shared.ts';\n`,
		);
		fs.writeFileSync(
			path.join(root, 'agents', 'second.ts'),
			`export { default } from '../shared.ts';\n`,
		);
		await build({ root, sourceRoot: root, target: 'node' });

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
});

function readEmittedJavaScript(output: string): string {
	return fs
		.readdirSync(output, { recursive: true })
		.filter((entry) => /\.[cm]?js$/.test(String(entry)))
		.map((entry) => fs.readFileSync(path.join(output, String(entry)), 'utf8'))
		.join('\n');
}

function createFixtureRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	return root;
}

function startGeneratedIpcChild(root: string, env: Record<string, string>): ChildProcess {
	return spawn('node', [path.join(root, 'dist', 'server.mjs')], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		env: { ...process.env, FLUE_MODE: 'local', ...env },
	});
}

async function waitForChildMessage(
	child: ChildProcess,
	predicate: (message: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.off('message', onMessage);
			reject(new Error('Expected IPC message was not received.'));
		}, 5000);
		const onMessage = (raw: unknown) => {
			const message = raw as Record<string, any>;
			if (!predicate(message)) return;
			clearTimeout(timeout);
			child.off('message', onMessage);
			resolve(message);
		};
		child.on('message', onMessage);
		child.once('error', reject);
	});
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
		socket.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), {
			once: true,
		});
	});
}

async function waitForClose(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((resolve) =>
		socket.addEventListener('close', () => resolve(), { once: true }),
	);
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
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', sourceRoot: '/tmp/flue-test', target: 'node' },
	};
}
