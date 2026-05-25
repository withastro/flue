import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { admin, flue } from '../src/app.ts';
import { createAgent } from '../src/agent-definition.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createRunSubscriberRegistry,
	generateWorkflowRunId,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	parseWorkflowRunId,
	type RunRecord,
	type RunStore,
} from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';

describe('workflow run ids', () => {
	it('round-trips workflow run id parts', () => {
		const runId = generateWorkflowRunId('daily-report');
		const parsed = parseWorkflowRunId(runId);
		expect(runId.startsWith('workflow:daily-report:')).toBe(true);
		expect(parsed?.workflowName).toBe('daily-report');
		expect(parsed?.runNonce).toBeTruthy();
	});

	it('rejects workflow names that cannot round-trip through run ids', () => {
		expect(() => generateWorkflowRunId('bad:name')).toThrow(/must not contain/);
	});
});

function workflowOwner(workflowName: string, runId: string) {
	return { kind: 'workflow' as const, workflowName, instanceId: runId };
}

describe('InMemoryRunRegistry', () => {
	it('records start, lookup, and end for one workflow run', async () => {
		const registry = new InMemoryRunRegistry();
		const runId = 'workflow:hello:a';
		await registry.recordRunStart({ runId, owner: workflowOwner('hello', runId), startedAt: '2026-01-01T00:00:00.000Z' });
		expect(await registry.lookupRun(runId)).toMatchObject({ runId, owner: workflowOwner('hello', runId), status: 'active' });
		expect(await registry.lookupRun('workflow:hello:missing')).toBeNull();
		await registry.recordRunEnd({ runId, endedAt: '2026-01-01T00:00:05.000Z', durationMs: 5000, isError: false });
		expect(await registry.lookupRun(runId)).toMatchObject({ status: 'completed', endedAt: '2026-01-01T00:00:05.000Z', durationMs: 5000, isError: false });
	});

	it('marks errored workflow run pointers', async () => {
		const registry = new InMemoryRunRegistry();
		const runId = 'workflow:hello:error';
		await registry.recordRunStart({ runId, owner: workflowOwner('hello', runId), startedAt: '2026-01-01T00:00:00.000Z' });
		await registry.recordRunEnd({ runId, endedAt: '2026-01-01T00:00:06.000Z', durationMs: 5000, isError: true });
		expect(await registry.lookupRun(runId)).toMatchObject({ status: 'errored', isError: true });
	});

	it('sorts and filters workflow runs by workflowName', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 5; i++) {
			const name = i % 2 === 0 ? 'hello' : 'greet';
			const runId = `workflow:${name}:${i}`;
			await registry.recordRunStart({ runId, owner: workflowOwner(name, runId), startedAt: `2026-01-01T00:00:0${i}.000Z` });
		}
		const all = await registry.listRuns();
		expect(all.runs.map((run) => run.runId)).toEqual(['workflow:hello:4', 'workflow:greet:3', 'workflow:hello:2', 'workflow:greet:1', 'workflow:hello:0']);
		const helloOnly = await registry.listRuns({ workflowName: 'hello' });
		expect(helloOnly.runs).toHaveLength(3);
		expect(helloOnly.runs.every((run) => run.owner.workflowName === 'hello')).toBe(true);
	});

	it('paginates workflow runs without duplicates', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 5; i++) {
			const runId = `workflow:hello:${i}`;
			await registry.recordRunStart({ runId, owner: workflowOwner('hello', runId), startedAt: `2026-01-01T00:00:0${i}.000Z` });
		}
		const page1 = await registry.listRuns({ limit: 2 });
		const page2 = await registry.listRuns({ limit: 2, cursor: page1.nextCursor });
		const page3 = await registry.listRuns({ limit: 2, cursor: page2.nextCursor });
		expect(page1.runs).toHaveLength(2);
		expect(page2.runs).toHaveLength(2);
		expect(page3.runs).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
		expect(new Set([...page1.runs, ...page2.runs, ...page3.runs].map((run) => run.runId)).size).toBe(5);
	});

	it('rejects workflow owner records whose instance id does not match the run id', async () => {
		const registry = new InMemoryRunRegistry();
		await expect(registry.recordRunStart({ runId: 'workflow:daily-report:01A', owner: workflowOwner('daily-report', 'workflow:daily-report:01B'), startedAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(/same instanceId/);
	});

	it('falls back to page 1 on a malformed cursor', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 3; i++) {
			const runId = `workflow:hello:${i}`;
			await registry.recordRunStart({ runId, owner: workflowOwner('hello', runId), startedAt: `2026-01-01T00:00:0${i}.000Z` });
		}
		expect((await registry.listRuns({ cursor: 'not-base64-json' })).runs).toHaveLength(3);
		expect((await registry.listRuns({ cursor: '' })).runs).toHaveLength(3);
	});
});

describe('run store persistence sizing', () => {
	it('persists rich model turn requests without reducing their content', async () => {
		const runStore = new InMemoryRunStore();
		const runId = 'workflow:trace:rich-turn';
		await runStore.createRun({
			runId,
			owner: workflowOwner('trace', runId),
			startedAt: '2026-05-24T00:00:00.000Z',
			payload: {},
		});
		const event: FlueEvent = {
			type: 'turn_request',
			turnId: 'turn_rich',
			purpose: 'agent',
			model: 'model',
			provider: 'provider',
			api: 'api',
			input: {
				systemPrompt: 'sensitive instructions',
				messages: [{ role: 'user', content: 'sensitive input' }],
			},
			runId,
		};
		await runStore.appendEvent(runId, event);

		expect(await runStore.getEvents(runId)).toEqual([event]);
	});

	it('surfaces oversized persisted events to callers', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'hello', channels: { http: true } }] },
			workflowHandlers: { hello: async () => ({ result: 'x'.repeat(1_100_000) }) },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(
			new Request('http://localhost/workflows/hello?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(500);
		const runs = await runRegistry.listRuns({});
		expect(runs.runs[0]?.status).toBe('completed');
	});

	it('finalizes runs after oversized non-terminal persistence failures', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'hello', channels: { http: true } }] },
			workflowHandlers: {
				hello: async (ctx) => {
					ctx.log.info('x'.repeat(1_100_000));
					return { ok: true };
				},
			},
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(
			new Request('http://localhost/workflows/hello?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(500);
		const runs = await runRegistry.listRuns({});
		expect(runs.runs[0]?.status).toBe('errored');
	});

	it('finalizes runs after oversized terminal error persistence failures', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'hello', channels: { http: true } }] },
			workflowHandlers: {
				hello: async () => {
					throw new Error('x'.repeat(1_100_000));
				},
			},
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(
			new Request('http://localhost/workflows/hello?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(500);
		const runs = await runRegistry.listRuns({});
		expect(runs.runs[0]?.status).toBe('errored');
	});
});

describe('POST /workflows/:name routes via flue()', () => {
	it('admits an HTTP workflow, returns a run id, and exposes run inspection', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', channels: { http: true } }] },
			handlers: {},
			workflowHandlers: { 'daily-report': async (ctx) => ({ echoed: ctx.payload }) },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});
		const app = new Hono();
		app.route('/', flue());

		const admitted = await app.fetch(
			new Request('http://localhost/workflows/daily-report', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ date: '2026-05-21' }),
			}),
		);
		expect(admitted.status).toBe(202);
		const body = (await admitted.json()) as { runId: string; status: string };
		expect(body.status).toBe('accepted');
		expect(body.runId.startsWith('workflow:daily-report:')).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 0));
		const runRes = await app.fetch(new Request(`http://localhost/runs/${body.runId}`));
		expect(runRes.status).toBe(200);
		expect(await runRes.json()).toMatchObject({
			runId: body.runId,
			owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: body.runId },
			status: 'completed',
			result: { echoed: { date: '2026-05-21' } },
		});
	});

	it('waits for workflow results when wait=result is requested', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', channels: { http: true } }] },
			handlers: {},
			workflowHandlers: { 'daily-report': async (ctx) => ({ echoed: ctx.payload }) },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(
			new Request('http://localhost/workflows/daily-report?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ date: '2026-05-21' }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: unknown; _meta: { runId: string } };
		expect(body.result).toEqual({ echoed: { date: '2026-05-21' } });
		expect(body._meta.runId.startsWith('workflow:daily-report:')).toBe(true);
	});

	it('returns workflow errors through wait=result while keeping the run id header', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'explode', channels: { http: true } }] },
			handlers: {},
			workflowHandlers: { explode: async () => { throw new Error('boom'); } },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(new Request('http://localhost/workflows/explode?wait=result', { method: 'POST' }));
		expect(res.status).toBe(500);
		expect(res.headers.get('x-flue-run-id')?.startsWith('workflow:explode:')).toBe(true);
	});

	it('streams workflow execution when SSE is explicitly requested', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', channels: { http: true } }] },
			handlers: {},
			workflowHandlers: { 'daily-report': async () => ({ ok: true }) },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});
		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(
			new Request('http://localhost/workflows/daily-report', {
				method: 'POST',
				headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
		const text = await res.text();
		expect(text).toMatch(/event: run_start/);
		expect(text).toMatch(/event: run_end/);
	});

	it('initializes a workflow-created agent only when run requests it and passes workflow payload', async () => {
		const initialized: Array<{ id: string; payload: unknown }> = [];
		const agent = createAgent(({ id, payload }) => {
			initialized.push({ id, payload });
			return { model: false };
		});
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'optional-agent', channels: { http: true } }] },
			handlers: {},
			workflowHandlers: {
				'optional-agent': async (ctx) => {
					if (!(ctx.payload as { useAgent?: boolean }).useAgent) return { initialized: false };
					await ctx.init(agent);
					return { initialized: true };
				},
			},
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({
						exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
						readFile: async () => '',
						readFileBuffer: async () => new Uint8Array(),
						writeFile: async () => {},
						stat: async () => ({ isFile: false, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }),
						readdir: async () => [],
						exists: async () => false,
						mkdir: async () => {},
						rm: async () => {},
						cwd: '/',
						resolvePath: (target: string) => target,
					}),
					defaultStore: new InMemorySessionStore(),
				}),
		});
		const app = new Hono();
		app.route('/', flue());
		const skipped = await app.fetch(new Request('http://localhost/workflows/optional-agent?wait=result', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useAgent: false }),
		}));
		expect((await skipped.json()) as unknown).toMatchObject({ result: { initialized: false } });
		expect(initialized).toEqual([]);
		const used = await app.fetch(new Request('http://localhost/workflows/optional-agent?wait=result', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useAgent: true }),
		}));
		expect(used.status).toBe(200);
		expect(initialized).toHaveLength(1);
		expect(initialized[0]?.payload).toEqual({ useAgent: true });
		expect(initialized[0]?.id).toMatch(/^workflow:optional-agent:/);
	});

	it('rejects internal-only workflows and non-POST methods', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'internal', channels: {} }] },
			handlers: {},
			workflowHandlers: { internal: async () => null },
			createContext: (() => null) as never,
		});
		const app = new Hono();
		app.route('/', flue());
		const internal = await app.fetch(new Request('http://localhost/workflows/internal', { method: 'POST' }));
		expect(internal.status).toBe(404);
		expect(((await internal.json()) as { error?: { type: string } }).error?.type).toBe('workflow_not_http');
		const badMethod = await app.fetch(new Request('http://localhost/workflows/internal'));
		expect(badMethod.status).toBe(405);
	});
});

describe('Bare /runs/:runId routes via flue()', () => {
	it('resolves a workflow run pointer and serves the record / events / stream', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();

		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'hello', channels: { http: true } }] },
			workflowHandlers: {
				hello: async (_ctx) => ({ greeting: 'hi' }),
			},
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: {
						systemPrompt: '',
						skills: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});

		const app = new Hono();
		app.route('/', flue());

		const invoke = await app.fetch(
			new Request('http://localhost/workflows/hello?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(invoke.status).toBe(200);
		const invokeBody = (await invoke.json()) as { _meta?: { runId?: string } };
		const runId = invokeBody._meta?.runId;
		expect(typeof runId).toBe('string');
		expect(runId?.startsWith('workflow:hello:')).toBe(true);

		const bare = await app.fetch(new Request(`http://localhost/runs/${runId}`));
		expect(bare.status).toBe(200);
		const bareBody = (await bare.json()) as {
			runId: string;
			owner: { kind: string; workflowName: string; instanceId: string };
			status: string;
			payload: unknown;
		};
		expect(bareBody.runId).toBe(runId);
		expect(bareBody.owner).toEqual({ kind: 'workflow', workflowName: 'hello', instanceId: runId });
		expect(bareBody.status).toBe('completed');
		expect(bareBody.payload).toEqual({});

		const missing = await app.fetch(new Request('http://localhost/runs/run_does_not_exist'));
		expect(missing.status).toBe(404);
		const missingBody = (await missing.json()) as { error?: { type: string } };
		expect(missingBody.error?.type).toBe('run_not_found');

		const eventsRes = await app.fetch(new Request(`http://localhost/runs/${runId}/events`));
		expect(eventsRes.status).toBe(200);
		const eventsBody = (await eventsRes.json()) as { events: { type: string }[] };
		expect(Array.isArray(eventsBody.events)).toBe(true);
		const types = new Set(eventsBody.events.map((e) => e.type));
		expect(types.has('run_start')).toBe(true);
		expect(types.has('run_end')).toBe(true);

		const badLimit = await app.fetch(new Request(`http://localhost/runs/${runId}/events?limit=abc`));
		expect(badLimit.status).toBe(400);
		expect(((await badLimit.json()) as { error?: { type: string } }).error?.type).toBe(
			'validation_failed',
		);

		const badType = await app.fetch(
			new Request(`http://localhost/runs/${runId}/events?types=run_start,not_real`),
		);
		expect(badType.status).toBe(400);

		const streamRes = await app.fetch(new Request(`http://localhost/runs/${runId}/stream`));
		expect(streamRes.status).toBe(200);
		expect(streamRes.headers.get('content-type')).toMatch(/text\/event-stream/);
		const streamBody = await streamRes.text();
		expect(streamBody).toMatch(/event: run_start/);
		expect(streamBody).toMatch(/event: run_end/);

		const specRes = await app.fetch(new Request('http://localhost/openapi.json'));
		expect(specRes.status).toBe(200);
		const spec = (await specRes.json()) as {
			openapi: string;
			info: { title: string; version: string };
			paths: Record<string, Record<string, unknown>>;
		};
		expect(spec.openapi).toBe('3.1.0');
		expect(spec.info.title).toBe('Flue Public API');
		expect(spec.paths['/agents/{name}/{id}']?.post).toBeDefined();
		expect(spec.paths['/runs/{runId}']?.get).toBeDefined();
		expect(spec.paths['/runs/{runId}/events']?.get).toBeDefined();
		const streamOp = spec.paths['/runs/{runId}/stream']?.get as
			| { 'x-flue-streaming'?: boolean }
			| undefined;
		expect(streamOp?.['x-flue-streaming']).toBe(true);
	});

	it('surfaces a structured 501 envelope when runRegistry is not configured', async () => {
		configureFlueRuntime({
			target: 'node',
			handlers: { hello: async () => null },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: {
						systemPrompt: '',
						skills: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore: new InMemoryRunStore(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(new Request('http://localhost/runs/run_anything'));
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: { type: string } };
		expect(body.error?.type).toBe('run_registry_unavailable');
	});

	it('computes public OpenAPI metadata lazily after runtime configuration', async () => {
		const app = new Hono();
		app.route('/', flue());

		configureFlueRuntime({
			target: 'node',
			runtimeVersion: '9.9.9',
			handlers: {},
			createContext: (() => null) as never,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const res = await app.fetch(new Request('http://localhost/openapi.json'));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { info: { version: string } }).info.version).toBe('9.9.9');
	});

	it('returns 405 for non-GET run inspection methods', async () => {
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			createContext: (() => null) as never,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());
		const res = await app.fetch(new Request('http://localhost/runs/run_anything', { method: 'POST' }));
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('GET');
	});

	it('preserves the original agent request body for Cloudflare route forwarding', async () => {
		const routedBodies: string[] = [];

		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'hello', channels: { http: true }, created: false }] },
			routeAgentRequest: async (request) => {
				routedBodies.push(await request.text());
				return Response.json({ ok: true });
			},
		});

		const app = new Hono();
		app.route('/', flue());
		const original = new Request('http://localhost/agents/hello/inst-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ caseNumber: '02101282' }),
		});

		const res = await app.fetch(original);
		expect(res.status).toBe(200);
		expect(routedBodies).toEqual(['{"caseNumber":"02101282"}']);
		expect(await original.text()).toBe('{"caseNumber":"02101282"}');
	});

	it('flushes queued non-terminal events before run_end is persisted', async () => {
		const runStore = new SlowNonTerminalRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();

		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'hello', channels: { http: true } }] },
			workflowHandlers: {
				hello: async (ctx) => {
					ctx.log.info('before return');
					return { ok: true };
				},
			},
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: {
						systemPrompt: '',
						skills: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});

		const app = new Hono();
		app.route('/', flue());

		const invoke = await app.fetch(
			new Request('http://localhost/workflows/hello?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		const runId = ((await invoke.json()) as { _meta: { runId: string } })._meta.runId;

		const eventsRes = await app.fetch(new Request(`http://localhost/runs/${runId}/events`));
		const events = ((await eventsRes.json()) as { events: Array<{ type: string }> }).events;
		const types = events.map((event) => event.type);
		const logIndex = types.indexOf('log');
		const endIndex = types.indexOf('run_end');

		expect(types[0]).toBe('run_start');
		expect(logIndex).toBeGreaterThan(-1);
		expect(endIndex).toBeGreaterThan(logIndex);
	});
});

class SlowNonTerminalRunStore implements RunStore {
	private inner = new InMemoryRunStore();

	createRun(input: Parameters<RunStore['createRun']>[0]): Promise<void> {
		return this.inner.createRun(input);
	}

	endRun(input: Parameters<RunStore['endRun']>[0]): Promise<void> {
		return this.inner.endRun(input);
	}

	async appendEvent(runId: string, event: FlueEvent): Promise<void> {
		if (event.type !== 'run_end') await new Promise((resolve) => setTimeout(resolve, 10));
		return this.inner.appendEvent(runId, event);
	}

	getEvents(runId: string, fromIndex?: number): ReturnType<RunStore['getEvents']> {
		return this.inner.getEvents(runId, fromIndex);
	}

	getRun(runId: string): Promise<RunRecord | null> {
		return this.inner.getRun(runId);
	}
}

describe('admin() routes', () => {
	it('lists agents and workflow runs and exposes an admin OpenAPI spec', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();

		configureFlueRuntime({
			target: 'node',
			runtimeVersion: '9.9.9',
			manifest: {
				agents: [
					{ name: 'hello', channels: {}, created: false },
					{ name: 'offline', channels: {}, created: false },
				],
				workflows: [{ name: 'daily-report', channels: { http: true } }],
			},
			workflowHandlers: { 'daily-report': async () => ({ ok: true }) },
			createContext: (id, runId, payload, req) =>
				createFlueContext({
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: {
						systemPrompt: '',
						skills: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});

		const app = new Hono();
		app.route('/', flue());
		app.route('/admin', admin());

		const invoke = await app.fetch(
			new Request('http://localhost/workflows/daily-report?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		const runId = ((await invoke.json()) as { _meta: { runId: string } })._meta.runId;

		const agents = await app.fetch(new Request('http://localhost/admin/agents'));
		expect(agents.status).toBe(200);
		expect((await agents.json()) as unknown).toMatchObject({
			items: [
				{ name: 'hello', created: false },
				{ name: 'offline', created: false },
			],
		});

		const instances = await app.fetch(new Request('http://localhost/admin/agents/hello/instances'));
		expect(instances.status).toBe(404);

		const instanceRuns = await app.fetch(
			new Request('http://localhost/admin/agents/hello/instances/inst-1/runs?status=completed'),
		);
		expect(instanceRuns.status).toBe(404);

		const runs = await app.fetch(new Request('http://localhost/admin/runs?workflowName=daily-report'));
		expect(runs.status).toBe(200);
		expect(((await runs.json()) as { items: { runId: string }[] }).items[0]?.runId).toBe(runId);

		const detail = await app.fetch(new Request(`http://localhost/admin/runs/${runId}`));
		expect(detail.status).toBe(200);
		expect(((await detail.json()) as { runId: string }).runId).toBe(runId);

		const badLimit = await app.fetch(new Request('http://localhost/admin/runs?limit=abc'));
		expect(badLimit.status).toBe(400);
		expect(((await badLimit.json()) as { error?: { type: string } }).error?.type).toBe(
			'validation_failed',
		);

		const spec = await app.fetch(new Request('http://localhost/admin/openapi.json'));
		expect(spec.status).toBe(200);
		const specBody = (await spec.json()) as { info: { title: string; version: string }; paths: Record<string, unknown> };
		expect(specBody.info).toMatchObject({ title: 'Flue Admin API', version: '9.9.9' });
		expect(specBody.paths['/agents']).toBeDefined();
		expect(specBody.paths['/runs']).toBeDefined();
	});

	it('rewrites admin run detail requests to the public run URL before Cloudflare DO forwarding', async () => {
		configureFlueRuntime({
			target: 'cloudflare',
			runtimeVersion: '9.9.9',
			manifest: { agents: [{ name: 'hello', channels: {}, created: false }] },
			createRunRegistryForRequest: () => ({
				recordRunStart: async () => {},
				recordRunEnd: async () => {},
				lookupRun: async () => ({
					runId: 'workflow:job:cf',
					owner: { kind: 'workflow', workflowName: 'job', instanceId: 'workflow:job:cf' },
					status: 'completed',
					startedAt: '2026-01-01T00:00:00.000Z',
				}),
				listRuns: async () => ({ runs: [] }),
			}),
			routeAgentRequest: async () => null,
			routeRunRequest: async (request) => {
				return new Response(JSON.stringify({ pathname: new URL(request.url).pathname }), {
					headers: { 'content-type': 'application/json' },
				});
			},
		});

		const app = new Hono();
		app.route('/admin', admin());

		const res = await app.fetch(new Request('http://localhost/admin/runs/run_cf'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ pathname: '/runs/run_cf' });
	});

	it('normalizes prefix-mounted public run requests before Cloudflare DO forwarding', async () => {
		configureFlueRuntime({
			target: 'cloudflare',
			runtimeVersion: '9.9.9',
			manifest: { agents: [{ name: 'hello', channels: {}, created: false }] },
			createRunRegistryForRequest: () => ({
				recordRunStart: async () => {},
				recordRunEnd: async () => {},
				lookupRun: async () => ({
					runId: 'workflow:job:cf',
					owner: { kind: 'workflow', workflowName: 'job', instanceId: 'workflow:job:cf' },
					status: 'completed',
					startedAt: '2026-01-01T00:00:00.000Z',
				}),
				listRuns: async () => ({ runs: [] }),
			}),
			routeAgentRequest: async () => null,
			routeRunRequest: async (request) => {
				const url = new URL(request.url);
				return new Response(JSON.stringify({ pathname: url.pathname, search: url.search }), {
					headers: { 'content-type': 'application/json' },
				});
			},
		});

		const app = new Hono();
		app.route('/api', flue());

		const res = await app.fetch(new Request('http://localhost/api/runs/run_cf/events?limit=1'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ pathname: '/runs/run_cf/events', search: '?limit=1' });
	});
});
