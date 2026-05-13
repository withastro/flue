/**
 * `InMemoryRunRegistry` (Node target) + the bare `/runs/:runId` routes
 * wired into `flue()`. Mix of direct unit tests against the registry
 * and an integration test that exercises the full request path via
 * Hono.
 *
 * Source imports work directly under vitest (vs. the strip-only Node
 * loader limitation that briefly bit us during the inline-script
 * days) — no `pnpm build` step required before `pnpm test`.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { admin, flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createRunSubscriberRegistry,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
} from '../src/internal.ts';

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
		// Descending: run_4 newest, run_0 oldest.
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
		// Duplicate pair — must not appear twice.
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

		// limit=1 walks all three in lex order; final page has no nextCursor.
		const p1 = await registry.listInstances({ limit: 1 });
		expect(p1.instances).toHaveLength(1);
		expect(p1.nextCursor).toBeDefined();
		const p2 = await registry.listInstances({ limit: 1, cursor: p1.nextCursor });
		const p3 = await registry.listInstances({ limit: 1, cursor: p2.nextCursor });
		expect(p3.nextCursor).toBeUndefined();
	});

	it('prunes completed pointers per-agent down to maxCompletedRunsPerAgent', async () => {
		const registry = new InMemoryRunRegistry({ maxCompletedRunsPerAgent: 3 });
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

	it('never prunes active runs even when above the cap', async () => {
		const registry = new InMemoryRunRegistry({ maxCompletedRunsPerAgent: 1 });
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
		// Empty-string cursor is treated as absent (Boolean falsy).
		expect((await registry.listRuns({ cursor: '' })).runs).toHaveLength(3);
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
						roles: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					createLocalEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore,
			runRegistry,
			runSubscribers,
		});

		const app = new Hono();
		app.route('/', flue());

		// Invoke the agent (sync mode).
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

		// Bare /runs/<runId>: the only run-lookup URL shape after Commit C.
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

		// Legacy prefixed shape no longer routes — falls through to Hono's
		// default 404.
		const legacy = await app.fetch(
			new Request(`http://localhost/agents/hello/inst-1/runs/${runId}`),
		);
		expect(legacy.status).toBe(404);

		// Unknown runId via the bare route returns a canonical envelope.
		const missing = await app.fetch(new Request('http://localhost/runs/run_does_not_exist'));
		expect(missing.status).toBe(404);
		const missingBody = (await missing.json()) as { error?: { type: string } };
		expect(missingBody.error?.type).toBe('run_not_found');

		// Events endpoint.
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

		// Stream endpoint on a terminal run returns SSE-replay.
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
						roles: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					createLocalEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
				}),
			runStore: new InMemoryRunStore(),
			runSubscribers: createRunSubscriberRegistry(),
			// runRegistry intentionally omitted.
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(new Request('http://localhost/runs/run_anything'));
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: { type: string } };
		expect(body.error?.type).toBe('run_registry_unavailable');
	});
});

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
						roles: {},
						model: undefined,
						resolveModel: () => undefined,
					},
					createDefaultEnv: async () => ({}) as never,
					createLocalEnv: async () => ({}) as never,
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
});
