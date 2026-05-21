import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { admin, flue } from '../src/app.ts';
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

describe('InMemoryRunRegistry', () => {
	it('records start, lookup, and end for a single run', async () => {
		const registry = new InMemoryRunRegistry();

		await registry.recordRunStart({
			runId: 'run_a',
			agentName: 'hello',
			instanceId: 'inst-1',
			startedAt: '2026-01-01T00:00:00.000Z',
		});

		const a = await registry.lookupRun('run_a');
		expect(a).toMatchObject({
			runId: 'run_a',
			agentName: 'hello',
			instanceId: 'inst-1',
			status: 'active',
		});
		expect(await registry.lookupRun('run_missing')).toBeNull();

		await registry.recordRunEnd({
			runId: 'run_a',
			endedAt: '2026-01-01T00:00:05.000Z',
			durationMs: 5000,
			isError: false,
		});
		const aDone = await registry.lookupRun('run_a');
		expect(aDone).toMatchObject({
			status: 'completed',
			endedAt: '2026-01-01T00:00:05.000Z',
			durationMs: 5000,
			isError: false,
		});
	});

	it('marks status="errored" when recordRunEnd has isError=true', async () => {
		const registry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'run_err',
			agentName: 'hello',
			instanceId: 'inst-1',
			startedAt: '2026-01-01T00:00:00.000Z',
		});
		await registry.recordRunEnd({
			runId: 'run_err',
			endedAt: '2026-01-01T00:00:06.000Z',
			durationMs: 5000,
			isError: true,
		});
		const done = await registry.lookupRun('run_err');
		expect(done?.status).toBe('errored');
		expect(done?.isError).toBe(true);
	});

	it('listRuns sorts descending by startedAt and filters by agentName', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 5; i++) {
			await registry.recordRunStart({
				runId: `run_${i}`,
				agentName: i % 2 === 0 ? 'hello' : 'greet',
				instanceId: `inst-${i}`,
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}

		const all = await registry.listRuns();
		expect(all.runs).toHaveLength(5);
		expect(all.runs[0]?.runId).toBe('run_4');
		expect(all.runs[4]?.runId).toBe('run_0');

		const helloOnly = await registry.listRuns({ agentName: 'hello' });
		expect(helloOnly.runs).toHaveLength(3);
		expect(helloOnly.runs.every((r) => r.agentName === 'hello')).toBe(true);
	});

	it('listRuns cursor pagination yields the full set with no dups', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 5; i++) {
			await registry.recordRunStart({
				runId: `run_${i}`,
				agentName: 'hello',
				instanceId: `inst-${i}`,
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}

		const page1 = await registry.listRuns({ limit: 2 });
		expect(page1.runs).toHaveLength(2);
		expect(page1.nextCursor).toBeDefined();
		const page2 = await registry.listRuns({ limit: 2, cursor: page1.nextCursor });
		expect(page2.runs).toHaveLength(2);
		const page3 = await registry.listRuns({ limit: 2, cursor: page2.nextCursor });
		expect(page3.runs).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();

		const collected = new Set([
			...page1.runs.map((r) => r.runId),
			...page2.runs.map((r) => r.runId),
			...page3.runs.map((r) => r.runId),
		]);
		expect(collected.size).toBe(5);
	});

	it('listInstances returns distinct (agent, instance) pairs and paginates', async () => {
		const registry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'r1',
			agentName: 'hello',
			instanceId: 'a',
			startedAt: '2026-01-01T00:00:00.000Z',
		});
		await registry.recordRunStart({
			runId: 'r2',
			agentName: 'hello',
			instanceId: 'b',
			startedAt: '2026-01-01T00:00:01.000Z',
		});
		await registry.recordRunStart({
			runId: 'r3',
			agentName: 'greet',
			instanceId: 'a',
			startedAt: '2026-01-01T00:00:02.000Z',
		});
		await registry.recordRunStart({
			runId: 'r4',
			agentName: 'hello',
			instanceId: 'a',
			startedAt: '2026-01-01T00:00:03.000Z',
		});

		const out = await registry.listInstances();
		expect(out.instances).toHaveLength(3);
		expect(out.instances.map((i) => `${i.agentName}/${i.instanceId}`).sort()).toEqual([
			'greet/a',
			'hello/a',
			'hello/b',
		]);

		const p1 = await registry.listInstances({ limit: 1 });
		expect(p1.instances).toHaveLength(1);
		expect(p1.nextCursor).toBeDefined();
		const p2 = await registry.listInstances({ limit: 1, cursor: p1.nextCursor });
		const p3 = await registry.listInstances({ limit: 1, cursor: p2.nextCursor });
		expect(p3.nextCursor).toBeUndefined();
	});

	it('prunes completed pointers per-instance down to maxCompletedRunsPerInstance', async () => {
		const registry = new InMemoryRunRegistry({ maxCompletedRunsPerInstance: 3 });
		for (let i = 0; i < 5; i++) {
			const id = `run_${i}`;
			await registry.recordRunStart({
				runId: id,
				agentName: 'hello',
				instanceId: 'inst-1',
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
			await registry.recordRunEnd({
				runId: id,
				endedAt: `2026-01-01T00:00:0${i + 1}.000Z`,
				durationMs: 1000,
				isError: false,
			});
		}
		const list = await registry.listRuns({ agentName: 'hello' });
		expect(list.runs).toHaveLength(3);
		expect(list.runs.map((r) => r.runId).sort()).toEqual(['run_2', 'run_3', 'run_4']);
		expect(await registry.lookupRun('run_0')).toBeNull();
	});

	it('does not prune one instance because another instance completed runs', async () => {
		const registry = new InMemoryRunRegistry({ maxCompletedRunsPerInstance: 2 });
		for (let instanceIndex = 1; instanceIndex <= 2; instanceIndex++) {
			for (let runIndex = 0; runIndex < 2; runIndex++) {
				const id = `run_i${instanceIndex}_${runIndex}`;
				await registry.recordRunStart({
					runId: id,
					agentName: 'hello',
					instanceId: `inst-${instanceIndex}`,
					startedAt: `2026-01-01T00:00:${instanceIndex}${runIndex}.000Z`,
				});
				await registry.recordRunEnd({
					runId: id,
					endedAt: `2026-01-01T00:00:${instanceIndex}${runIndex}.500Z`,
					durationMs: 500,
					isError: false,
				});
			}
		}

		const list = await registry.listRuns({ agentName: 'hello' });
		expect(list.runs).toHaveLength(4);
		expect(await registry.lookupRun('run_i1_0')).not.toBeNull();
		expect(await registry.lookupRun('run_i2_0')).not.toBeNull();
	});

	it('never prunes active runs even when above the cap', async () => {
		const registry = new InMemoryRunRegistry({ maxCompletedRunsPerInstance: 1 });
		for (let i = 0; i < 5; i++) {
			await registry.recordRunStart({
				runId: `active_${i}`,
				agentName: 'hello',
				instanceId: 'x',
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}
		const stillActive = await registry.listRuns({ agentName: 'hello' });
		expect(stillActive.runs).toHaveLength(5);
	});

	it('records workflow owners and filters by workflowName', async () => {
		const registry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:01TEST';
		await registry.recordRunStart({
			runId,
			owner: { kind: 'workflow', workflowName: 'daily-report', runId },
			startedAt: '2026-01-01T00:00:00.000Z',
		});
		expect(await registry.lookupRun(runId)).toMatchObject({
			runId,
			owner: { kind: 'workflow', workflowName: 'daily-report', runId },
		});
		expect((await registry.listRuns({ workflowName: 'daily-report' })).runs).toHaveLength(1);
		expect((await registry.listRuns({ workflowName: 'other' })).runs).toHaveLength(0);
	});

	it('rejects workflow owner records whose serialized run id does not match', async () => {
		const registry = new InMemoryRunRegistry();
		await expect(
			registry.recordRunStart({
				runId: 'workflow:daily-report:01A',
				owner: { kind: 'workflow', workflowName: 'daily-report', runId: 'workflow:daily-report:01B' },
				startedAt: '2026-01-01T00:00:00.000Z',
			}),
		).rejects.toThrow(/same runId/);
	});

	it('falls back to page 1 on a malformed cursor (rather than empty / error)', async () => {
		const registry = new InMemoryRunRegistry();
		for (let i = 0; i < 3; i++) {
			await registry.recordRunStart({
				runId: `run_${i}`,
				agentName: 'hello',
				instanceId: 'a',
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}
		expect((await registry.listRuns({ cursor: 'not-base64-json' })).runs).toHaveLength(3);
		expect((await registry.listInstances({ cursor: 'still-garbage' })).instances).toHaveLength(1);
		expect((await registry.listRuns({ cursor: '' })).runs).toHaveLength(3);
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
			webhookAgents: [],
			allowNonWebhook: false,
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
			owner: { kind: 'workflow', workflowName: 'daily-report', runId: body.runId },
			status: 'completed',
			result: { echoed: { date: '2026-05-21' } },
		});
	});

	it('waits for workflow results when wait=result is requested', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', channels: { http: true } }] },
			webhookAgents: [],
			allowNonWebhook: false,
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
			webhookAgents: [],
			allowNonWebhook: false,
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
			webhookAgents: [],
			allowNonWebhook: false,
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

	it('rejects internal-only workflows and non-POST methods', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'internal', channels: {} }] },
			webhookAgents: [],
			allowNonWebhook: false,
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
	it('resolves a registry pointer and serves the run record / events / stream', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();

		configureFlueRuntime({
			target: 'node',
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: {
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
			new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		expect(invoke.status).toBe(200);
		const invokeBody = (await invoke.json()) as { _meta?: { runId?: string } };
		const runId = invokeBody._meta?.runId;
		expect(typeof runId).toBe('string');
		expect(runId?.startsWith('run_')).toBe(true);

		const bare = await app.fetch(new Request(`http://localhost/runs/${runId}`));
		expect(bare.status).toBe(200);
		const bareBody = (await bare.json()) as {
			runId: string;
			agentName: string;
			instanceId: string;
			status: string;
		};
		expect(bareBody.runId).toBe(runId);
		expect(bareBody.agentName).toBe('hello');
		expect(bareBody.instanceId).toBe('inst-1');
		expect(bareBody.status).toBe('completed');

		const legacy = await app.fetch(
			new Request(`http://localhost/agents/hello/inst-1/runs/${runId}`),
		);
		expect(legacy.status).toBe(404);

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
			webhookAgents: ['hello'],
			allowNonWebhook: false,
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
			webhookAgents: [],
			allowNonWebhook: false,
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
			webhookAgents: [],
			allowNonWebhook: false,
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
			manifest: { agents: [{ name: 'hello', triggers: { webhook: true } }] },
			webhookAgents: ['hello'],
			allowNonWebhook: false,
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
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: {
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
			new Request('http://localhost/agents/hello/inst-1', {
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

	getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		return this.inner.getEvents(runId, fromIndex);
	}

	getRun(runId: string): Promise<RunRecord | null> {
		return this.inner.getRun(runId);
	}
}

describe('admin() routes', () => {
	it('lists agents, instances, runs, and exposes an admin OpenAPI spec', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runSubscribers = createRunSubscriberRegistry();

		configureFlueRuntime({
			target: 'node',
			runtimeVersion: '9.9.9',
			manifest: {
				agents: [
					{ name: 'hello', triggers: { webhook: true } },
					{ name: 'offline', triggers: {} },
				],
			},
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: { hello: async () => ({ ok: true }) },
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
			new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
		);
		const runId = ((await invoke.json()) as { _meta: { runId: string } })._meta.runId;

		const agents = await app.fetch(new Request('http://localhost/admin/agents'));
		expect(agents.status).toBe(200);
		expect(((await agents.json()) as { items: { name: string }[] }).items.map((a) => a.name)).toEqual([
			'hello',
			'offline',
		]);

		const instances = await app.fetch(new Request('http://localhost/admin/agents/hello/instances'));
		expect(instances.status).toBe(200);
		expect((await instances.json()) as unknown).toMatchObject({
			items: [{ agentName: 'hello', instanceId: 'inst-1' }],
		});

		const instanceRuns = await app.fetch(
			new Request('http://localhost/admin/agents/hello/instances/inst-1/runs?status=completed'),
		);
		expect(instanceRuns.status).toBe(200);
		expect(((await instanceRuns.json()) as { items: { runId: string }[] }).items[0]?.runId).toBe(runId);

		const runs = await app.fetch(new Request('http://localhost/admin/runs?agentName=hello'));
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
			manifest: { agents: [{ name: 'hello', triggers: { webhook: true } }] },
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			createRunRegistryForRequest: () => ({
				recordRunStart: async () => {},
				recordRunEnd: async () => {},
				lookupRun: async () => ({
					runId: 'run_cf',
					owner: { kind: 'agent', agentName: 'hello', instanceId: 'inst-1' },
					agentName: 'hello',
					instanceId: 'inst-1',
					status: 'completed',
					startedAt: '2026-01-01T00:00:00.000Z',
				}),
				listRuns: async () => ({ runs: [] }),
				listInstances: async () => ({ instances: [] }),
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
			manifest: { agents: [{ name: 'hello', triggers: { webhook: true } }] },
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			createRunRegistryForRequest: () => ({
				recordRunStart: async () => {},
				recordRunEnd: async () => {},
				lookupRun: async () => ({
					runId: 'run_cf',
					owner: { kind: 'agent', agentName: 'hello', instanceId: 'inst-1' },
					agentName: 'hello',
					instanceId: 'inst-1',
					status: 'completed',
					startedAt: '2026-01-01T00:00:00.000Z',
				}),
				listRuns: async () => ({ runs: [] }),
				listInstances: async () => ({ instances: [] }),
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
