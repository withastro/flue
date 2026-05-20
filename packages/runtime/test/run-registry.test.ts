import { Hono } from 'hono';
import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { admin, flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createRunSubscriberRegistry,
	bashFactoryToSessionEnv,
	InMemoryDefaultWorkspaceStore,
	InMemoryInstanceRunAdmission,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	InMemoryRegistrationStore,
	type RunRecord,
	type RunStore,
} from '../src/internal.ts';
import { AgentBusyError } from '../src/errors.ts';
import type { AgentConfig, FlueEvent, FlueHarness, FlueSession, ToolDefinition } from '../src/types.ts';

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
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					defaultStore: new InMemorySessionStore(),
					registrationStore: new InMemoryRegistrationStore(),
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

	it('rejects overlapping runs for the same instance and releases afterward', async () => {
		const instanceAdmission = new InMemoryInstanceRunAdmission();
		let releaseRun: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});

		configureFlueRuntime({
			target: 'node',
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: { hello: async () => wait },
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
					id,
					runId,
					payload,
					env: {},
					req,
					agentConfig: { systemPrompt: '', skills: {}, roles: {}, model: undefined, resolveModel: () => undefined },
					createDefaultEnv: async () => ({}) as never,
					defaultStore: new InMemorySessionStore(),
					registrationStore: new InMemoryRegistrationStore(),
				}),
			instanceAdmission,
		});

		const app = new Hono();
		app.route('/', flue());
		const first = app.fetch(new Request('http://localhost/agents/hello/inst-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
		await Promise.resolve();
		const second = await app.fetch(new Request('http://localhost/agents/hello/inst-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error?: { type?: string } }).error?.type).toBe('instance_busy');
		releaseRun?.();
		expect((await first).status).toBe(200);
		const third = await app.fetch(new Request('http://localhost/agents/hello/inst-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
		expect(third.status).toBe(200);
	});

	it('surfaces a structured 501 envelope when runRegistry is not configured', async () => {
		configureFlueRuntime({
			target: 'node',
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: { hello: async () => null },
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					defaultStore: new InMemorySessionStore(),
					registrationStore: new InMemoryRegistrationStore(),
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

	it('sends fire-and-forget prompts to the selected session and rejects overlapping sends', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-send',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});
		const agent = await ctx.init({ model: false });
		const sent: Array<{ session: string | undefined; message: string }> = [];
		let releaseSend: (() => void) | undefined;
		const pendingSend = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const fakeSession = {
			prompt(message: string) {
				sent.push({ session: 'inbox', message });
				return pendingSend as never;
			},
		} as unknown as FlueSession;
		const harness = agent.harness() as FlueHarness;
		const originalSession = harness.session.bind(harness);
		(harness as FlueHarness).session = async (name?: string) => {
			if (name === 'inbox') return fakeSession;
			return originalSession(name);
		};

		agent.send('hello', { session: 'inbox' });
		await Promise.resolve();
		expect(sent).toEqual([{ session: 'inbox', message: 'hello' }]);
		expect(() => agent.send('again', { session: 'inbox' })).toThrow(AgentBusyError);
		releaseSend?.();
		await pendingSend;
		await new Promise((resolve) => setTimeout(resolve, 0));
		agent.send('after-finish', { session: 'inbox' });
		await Promise.resolve();
		expect(sent).toEqual([
			{ session: 'inbox', message: 'hello' },
			{ session: 'inbox', message: 'after-finish' },
		]);
	});

	it('logs detached send failures and clears the busy flag afterward', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-send-error',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const agent = await ctx.init({ model: false });
		const harness = agent.harness() as FlueHarness;
		let failSession = true;
		(harness as FlueHarness).session = async () => {
			if (failSession) {
				failSession = false;
				throw new Error('session failed');
			}
			return {
				prompt() {
					return Promise.reject(new Error('prompt failed')) as never;
				},
			} as unknown as FlueSession;
		};

		agent.send('session failure');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events.at(-1)).toMatchObject({
			type: 'log',
			level: 'error',
			message: 'agent.send() failed.',
			attributes: { error: { message: 'session failed' } },
		});

		agent.send('prompt failure');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events.at(-1)).toMatchObject({
			type: 'log',
			level: 'error',
			message: 'agent.send() failed.',
			attributes: { error: { message: 'prompt failed' } },
		});
	});

	it('applies inherited init fields and replaces them with init-level overrides', async () => {
		const modelInputs: Array<string | false | undefined> = [];
		const inheritedTool: ToolDefinition = {
			name: 'inherited',
			description: 'Inherited tool.',
			parameters: {},
			execute: async () => 'inherited',
		};
		const overrideTool: ToolDefinition = {
			name: 'override',
			description: 'Override tool.',
			parameters: {},
			execute: async () => 'override',
		};
		const baseAgentConfig: AgentConfig = {
			systemPrompt: '',
			skills: {},
			roles: {},
			model: undefined,
			thinkingLevel: 'medium',
			compaction: { reserveTokens: 1 },
			resolveModel: (model) => {
				modelInputs.push(model);
				return undefined;
			},
		};
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-1',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: baseAgentConfig,
		});

		const inherited = await ctx.init({
			name: 'inherited',
			inherit: {
				model: 'anthropic/inherited',
				tools: [inheritedTool],
				thinkingLevel: 'high',
				compaction: false,
			},
		});
		const inheritedHarness = inherited.harness() as unknown as {
			config: AgentConfig;
			agentTools: ToolDefinition[];
		};
		expect(modelInputs).toEqual(['anthropic/inherited']);
		expect(inheritedHarness.config.thinkingLevel).toBe('high');
		expect(inheritedHarness.config.compaction).toBe(false);
		expect(inheritedHarness.agentTools).toEqual([inheritedTool]);

		const overridden = await ctx.init({
			name: 'override',
			inherit: {
				model: 'anthropic/inherited',
				tools: [inheritedTool],
				thinkingLevel: 'high',
				compaction: false,
			},
			model: false,
			tools: [overrideTool],
			thinkingLevel: 'low',
			compaction: { keepRecentTokens: 2 },
		});
		const overriddenHarness = overridden.harness() as unknown as {
			config: AgentConfig;
			agentTools: ToolDefinition[];
		};
		expect(modelInputs).toEqual(['anthropic/inherited', false]);
		expect(overriddenHarness.config.thinkingLevel).toBe('low');
		expect(overriddenHarness.config.compaction).toEqual({ keepRecentTokens: 2 });
		expect(overriddenHarness.agentTools).toEqual([overrideTool]);
	});

	it('adds inherited skills to the active catalog without injecting skill bodies', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-skills',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});

		const agent = await ctx.init({
			inherit: {
				model: false,
				skills: [
					{
						name: 'review',
						description: 'Review work.',
						body: 'Hidden review instructions.',
						source: { kind: 'local', path: '/skills/review/SKILL.md' },
					},
				],
			},
		});
		const harness = agent.harness() as unknown as { config: AgentConfig };
		expect(harness.config.skills.review).toMatchObject({ name: 'review', description: 'Review work.' });
		expect(harness.config.systemPrompt).toContain('**review** — Review work.');
		expect(harness.config.systemPrompt).not.toContain('Hidden review instructions.');

		const childContext = await (agent.harness() as unknown as {
			createTaskSession(options: {
				parentSession: string;
				taskId: string;
				parentEnv: unknown;
				depth: number;
			}): Promise<{ config: AgentConfig }>;
		}).createTaskSession({
			parentSession: 'default',
			taskId: 'skill-child',
			parentEnv: await bashFactoryToSessionEnv(async () => new Bash()),
			depth: 1,
		});
		expect(childContext.config.skills.review).toMatchObject({ name: 'review', description: 'Review work.' });
		expect(childContext.config.systemPrompt).toContain('**review** — Review work.');
		expect(childContext.config.systemPrompt).not.toContain('Hidden review instructions.');
	});

	it('uses inherited instructions and lets init-level instructions replace them', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-instructions',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});

		const inherited = await ctx.init({
			name: 'instructions-inherited',
			inherit: { model: false, instructions: 'Inherited agent instructions.' },
		});
		const inheritedHarness = inherited.harness() as unknown as { config: AgentConfig };
		expect(inheritedHarness.config.systemPrompt).toContain('Inherited agent instructions.');
		expect(inheritedHarness.config.instructions).toBe('Inherited agent instructions.');

		const childContext = await (inherited.harness() as unknown as {
			createTaskSession(options: {
				parentSession: string;
				taskId: string;
				parentEnv: unknown;
				depth: number;
			}): Promise<{ config: AgentConfig }>;
		}).createTaskSession({
			parentSession: 'default',
			taskId: 'child',
			parentEnv: await bashFactoryToSessionEnv(async () => new Bash()),
			depth: 1,
		});
		expect(childContext.config.systemPrompt).toContain('Inherited agent instructions.');

		const overridden = await ctx.init({
			name: 'instructions-override',
			inherit: { model: false, instructions: 'Inherited agent instructions.' },
			instructions: 'Override agent instructions.',
		});
		const overriddenHarness = overridden.harness() as unknown as { config: AgentConfig };
		expect(overriddenHarness.config.systemPrompt).toContain('Override agent instructions.');
		expect(overriddenHarness.config.systemPrompt).not.toContain('Inherited agent instructions.');
	});

	it('keeps the missing-model error when neither init nor inherit supplies one', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-model-error',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});

		await expect(ctx.init({})).rejects.toThrow('requires a model');
		await expect(ctx.init({ inherit: { tools: [] } })).rejects.toThrow('requires a model');
	});

	it('accepts inherited models when init-level model is omitted', async () => {
		const ctx = createFlueContext({
			agentName: 'hello',
			id: 'inst-1',
			runId: 'run-2',
			payload: {},
			env: {},
			createDefaultEnv: async () => bashFactoryToSessionEnv(async () => new Bash()),
			defaultStore: new InMemorySessionStore(),
			registrationStore: new InMemoryRegistrationStore(),
			agentConfig: {
				systemPrompt: '',
				skills: {},
				roles: {},
				model: undefined,
				resolveModel: () => undefined,
			},
		});

		await expect(ctx.init({ inherit: { model: false } })).resolves.toMatchObject({
			name: 'hello',
			id: 'inst-1',
		});
	});

	it('persists registered default workspace files by instance while harnesses remain isolated', async () => {
		const workspaceStore = new InMemoryDefaultWorkspaceStore();
		const registrationStore = new InMemoryRegistrationStore();
		let hydrationRuns = 0;

		configureFlueRuntime({
			target: 'node',
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: {
				hello: async (ctx) => {
					const harnessName = String((ctx.payload as { harness?: string }).harness ?? 'default');
					const agent = await ctx.init({ name: harnessName, model: false });
					const harness = agent.harness();
					expect(agent.name).toBe('hello');
					expect(agent.id).toBe(ctx.id);
					expect(agent.harness()).toBe(harness);
					expect(harness.name).toBe(harnessName);
					await ctx.register(async () => {
						hydrationRuns += 1;
						await harness.fs.writeFile('/hydrated.txt', `${ctx.id}:${harnessName}`);
					});
					const write = (ctx.payload as { write?: string }).write;
					if (write) await harness.fs.writeFile('/workspace.txt', write);
					return {
						hydrated: await harness.fs.readFile('/hydrated.txt').catch(() => null),
						value: await harness.fs.readFile('/workspace.txt').catch(() => null),
					};
				},
			},
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					createDefaultEnv: async (scope) => {
						const fs = await workspaceStore.get(scope);
						return bashFactoryToSessionEnv(async () => new Bash({ fs }));
					},
					defaultStore: new InMemorySessionStore(),
					registrationStore,
				}),
		});

		const app = new Hono();
		app.route('/', flue());
		const invoke = async (id: string, payload: { harness?: string; write?: string } = {}) =>
			(await app.fetch(
				new Request(`http://localhost/agents/hello/${id}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				}),
			)).json() as Promise<{ result: { hydrated: string | null; value: string | null } }>;

		expect((await invoke('stable', { write: 'persisted' })).result).toEqual({
			hydrated: 'stable:default',
			value: 'persisted',
		});
		expect((await invoke('stable')).result.hydrated).toBe('stable:default');
		expect((await invoke('stable')).result.value).toBe('persisted');
		expect((await invoke('stable', { harness: 'other' })).result.hydrated).toBeNull();
		expect((await invoke('stable', { harness: 'other', write: 'other-data' })).result.value).toBe(
			'other-data',
		);
		expect((await invoke('stable', { harness: 'other' })).result.value).toBe('other-data');
		expect((await invoke('isolated')).result.hydrated).toBe('isolated:default');
		expect(hydrationRuns).toBe(2);
	});

	it('runs register once per instance, retries failures, and rejects a second call in one request', async () => {
		const registrationStore = new InMemoryRegistrationStore();
		const calls: string[] = [];
		let shouldFail = true;

		configureFlueRuntime({
			target: 'node',
			webhookAgents: ['hello'],
			allowNonWebhook: false,
			handlers: {
				hello: async (ctx) => {
					await ctx.register(async () => {
						calls.push(ctx.id);
						if (ctx.id === 'retry' && shouldFail) {
							shouldFail = false;
							throw new Error('registration failed');
						}
					});
					if (ctx.id === 'double') {
						await ctx.register(async () => undefined);
					}
					return { ok: true };
				},
			},
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					defaultStore: new InMemorySessionStore(),
					registrationStore,
				}),
			runStore: new InMemoryRunStore(),
			instanceAdmission: new InMemoryInstanceRunAdmission(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());
		const invoke = (id: string) =>
			app.fetch(
				new Request(`http://localhost/agents/hello/${id}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({}),
				}),
			);

		expect((await invoke('stable')).status).toBe(200);
		expect((await invoke('stable')).status).toBe(200);
		expect(calls).toEqual(['stable']);

		expect((await invoke('retry')).status).toBe(500);
		expect((await invoke('retry')).status).toBe(200);
		expect((await invoke('retry')).status).toBe(200);
		expect(calls).toEqual(['stable', 'retry', 'retry']);

		const double = await invoke('double');
		expect(double.status).toBe(500);
	});

	it('scopes registration completion by agent name and claims duplicate registrations once', async () => {
		const registrationStore = new InMemoryRegistrationStore();
		const first = { agentName: 'alpha', instanceId: 'shared' };
		const duplicate = await Promise.all([
			registrationStore.claim(first),
			registrationStore.claim(first),
		]);
		expect(duplicate.filter(Boolean)).toHaveLength(1);
		await duplicate.find(Boolean)?.complete();
		expect(await registrationStore.claim(first)).toBeNull();
		expect(await registrationStore.claim({ agentName: 'beta', instanceId: 'shared' })).toBeTruthy();
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
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					defaultStore: new InMemorySessionStore(),
					registrationStore: new InMemoryRegistrationStore(),
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
			createContext: (agentName, id, runId, payload, req) =>
				createFlueContext({
					agentName,
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
					defaultStore: new InMemorySessionStore(),
					registrationStore: new InMemoryRegistrationStore(),
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
