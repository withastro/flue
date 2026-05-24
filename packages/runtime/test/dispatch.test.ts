import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
	persistAgentDispatchAdmission,
	createAgentDispatchProcessor,
	createFlueContext,
	configureFlueRuntime,
	InMemoryDispatchQueue,
	InMemoryRunStore,
	InMemorySessionStore,
	type DispatchInput,
} from '../src/internal.ts';
import { createAgent } from '../src/agent-definition.ts';
import { dispatch } from '../src/index.ts';
import { Harness } from '../src/harness.ts';
import type { AgentConfig, FlueHarness, FlueSession, SessionEnv } from '../src/types.ts';

describe('global dispatch', () => {
	it('dispatches by registered agent name and defaults the target session', async () => {
		const dispatches: DispatchInput[] = [];
		const queue = new InMemoryDispatchQueue({ process(input) { dispatches.push(input); } });

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			dispatchQueue: queue,
			manifest: { agents: [{ name: 'moderator', channels: {}, created: true }] },
		});

		const receipt = await dispatch({ agent: 'moderator', id: 'guild:1', input: { type: 'flagged' } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(receipt).toMatchObject({ dispatchId: expect.any(String), acceptedAt: expect.any(String) });
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'default',
			input: { type: 'flagged' },
		});
	});

	it('snapshots input at admission time and validates named dispatch requests', async () => {
		const dispatches: DispatchInput[] = [];
		const input = { nested: { count: 1 } };
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue({ process(item) { dispatches.push(item); } }),
			manifest: { agents: [{ name: 'moderator', channels: {}, created: true }] },
		});

		await dispatch({ agent: 'moderator', id: 'guild:1', input });
		input.nested.count = 2;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(dispatches[0]?.input).toEqual({ nested: { count: 1 } });
		await expect(dispatch({ agent: 'missing', id: 'guild:1', input: null })).rejects.toThrow('target agent "missing" is not registered');
		await expect(dispatch({ agent: 'moderator', id: 'guild:1', input: { fn: () => 'nope' } })).rejects.toThrow('must not contain function values');
	});

	it('dispatches by a discovered created-agent identity and rejects undiscovered identities', async () => {
		const agent = createAgent(() => ({ model: false }));
		const localAgent = createAgent(() => ({ model: false }));
		const dispatches: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: new InMemoryDispatchQueue({ process(input) { dispatches.push(input); } }),
			resolveDispatchAgentName: (candidate) => candidate === agent ? 'moderator' : undefined,
			manifest: { agents: [{ name: 'moderator', channels: {}, created: true }] },
		});

		await dispatch(agent, { id: 'guild:1', session: 'case:1', input: { type: 'created' } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(dispatches[0]).toMatchObject({ targetAgent: 'moderator', session: 'case:1', input: { type: 'created' } });
		await expect(dispatch(localAgent, { id: 'guild:1', input: null })).rejects.toThrow('not a discovered default-exported agent');
	});

	it('admits dispatch through a configured Cloudflare target forwarding queue', async () => {
		const dispatches: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'cloudflare',
			dispatchQueue: {
				async enqueue(input) {
					dispatches.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			manifest: { agents: [{ name: 'moderator', channels: {}, created: true }] },
		});

		const receipt = await dispatch({ agent: 'moderator', id: 'guild:1', input: null });
		expect(receipt).toMatchObject({ dispatchId: expect.any(String), acceptedAt: expect.any(String) });
		expect(dispatches[0]).toMatchObject({ targetAgent: 'moderator', id: 'guild:1', session: 'default', input: null });
	});

	it('processes dispatches by waking the target instance and session', async () => {
		const processed: DispatchInput[] = [];
		const sessions: string[] = [];
		const events: string[] = [];
		const processor = createAgentDispatchProcessor({
			agents: {
				moderator: createAgent(({ id, payload }) => {
					expect(id).toBe('guild:1');
					expect(payload).toBeUndefined();
					return { model: false };
				}),
			},
			createContext: (...args) => {
				const ctx = createTestContext(...args);
				ctx.initializeCreatedAgent = async () => fakeDispatchHarness(sessions, processed);
				ctx.subscribeEvent((event) => { events.push(event.type); });
				return ctx;
			},
		});

		await processor.process({
			dispatchId: 'dispatch-1',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { type: 'flagged' },
			acceptedAt: '2026-05-21T00:00:00.000Z',
		});

		expect(sessions).toEqual(['case:1']);
		expect(processed).toHaveLength(1);
		expect(processed[0]?.input).toEqual({ type: 'flagged' });
		expect(events).toEqual([]);
	});

	it('admits durable dispatch processing without creating a run record', async () => {
		const runStore = new InMemoryRunStore();
		const input: DispatchInput = {
			dispatchId: 'dispatch-durable',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { type: 'durable' },
			acceptedAt: '2026-05-21T00:00:00.000Z',
		};

		const receipt = await persistAgentDispatchAdmission({ input, createContext: createTestContext });
		expect(receipt).toEqual({ dispatchId: 'dispatch-durable', acceptedAt: '2026-05-21T00:00:00.000Z' });
		expect(await runStore.getRun('dispatch-durable')).toBeNull();
	});

	it('processes a durable dispatch with dispatch identity instead of run lifecycle', async () => {
		const runStore = new InMemoryRunStore();
		const input: DispatchInput = {
			dispatchId: 'dispatch-process', targetAgent: 'moderator', agent: 'moderator', id: 'guild:1', session: 'case:1',
			input: { text: 'one' }, acceptedAt: '2026-05-21T00:00:00.000Z',
		};
		let contextRunId: string | undefined = 'unread';
		const processor = createAgentDispatchProcessor({
			agents: { moderator: createAgent(() => ({ model: false })) },
			createContext: (id, runId, payload, request, initialEventIndex) => {
				contextRunId = runId;
				const ctx = createTestContext(id, runId, payload, request, initialEventIndex);
				ctx.initializeCreatedAgent = async () => fakeDispatchHarness([], []);
				return ctx;
			},
		});
		await processor.process(input);
		expect(contextRunId).toBeUndefined();
		expect(await runStore.getRun(input.dispatchId)).toBeNull();
		expect(await runStore.getEvents(input.dispatchId)).toEqual([]);
	});

	it('connects dispatch through the Node queue to target session processing', async () => {
		const processed: DispatchInput[] = [];
		const sessions: string[] = [];
		const agent = createAgent(() => ({ model: false }));
		const queue = new InMemoryDispatchQueue(createAgentDispatchProcessor({
			agents: { moderator: agent },
			createContext: (...args) => {
				const ctx = createTestContext(...args);
				ctx.initializeCreatedAgent = async () => fakeDispatchHarness(sessions, processed);
				return ctx;
			},
		}));
		configureFlueRuntime({
			target: 'node', dispatchQueue: queue,
			resolveDispatchAgentName: (candidate) => candidate === agent ? 'moderator' : undefined,
			manifest: { agents: [{ name: 'moderator', channels: {}, created: true }] },
		});

		await dispatch(agent, { id: 'guild:1', input: { type: 'global' } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sessions).toEqual(['default']);
		expect(processed[0]).toMatchObject({ targetAgent: 'moderator', id: 'guild:1', session: 'default', input: { type: 'global' } });
	});

	it('persists dispatched input once and reuses it during recovery', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness('guild:1', 'default', testAgentConfig(), fakeEnv(), store);
		const session = await harness.session('case:1');
		const agent = Reflect.get(session, 'harness') as { state: { messages: AgentMessage[] }; continue: () => Promise<void>; waitForIdle: () => Promise<void> };
		let continuations = 0;
		agent.continue = async () => {
			continuations += 1;
			agent.state.messages.push(assistantMessage());
		};
		agent.waitForIdle = async () => {};
		const input: DispatchInput = { dispatchId: 'dispatch-persisted', targetAgent: 'moderator', agent: 'moderator', id: 'guild:1', session: 'case:1', input: { type: 'flagged' }, acceptedAt: '2026-05-21T00:00:00.000Z' };
		const dispatched = session as FlueSession & { processDispatchInput(input: DispatchInput): PromiseLike<unknown> };

		await dispatched.processDispatchInput(input);
		await dispatched.processDispatchInput(input);
		const data = await store.load('agent-session:["guild:1","default","case:1"]');
		expect(continuations).toBe(1);
		expect(data?.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
		expect(data?.entries[0]).toMatchObject({ source: 'dispatch', dispatch: { dispatchId: 'dispatch-persisted' } });
	});

	it('renders dispatched input deterministically and preserves structured metadata', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness('guild:1', 'default', testAgentConfig(), fakeEnv(), store);
		const session = await harness.session('case:1');
		const agent = Reflect.get(session, 'harness') as { state: { messages: AgentMessage[] }; continue: () => Promise<void>; waitForIdle: () => Promise<void> };
		agent.continue = async () => { agent.state.messages.push(assistantMessage()); };
		agent.waitForIdle = async () => {};
		await (session as FlueSession & { processDispatchInput(input: DispatchInput): PromiseLike<unknown> }).processDispatchInput({
			dispatchId: 'dispatch-1', targetAgent: 'moderator', agent: 'moderator', id: 'guild:1', session: 'case:1',
			input: { z: 1, a: { b: 2, a: 1 } }, acceptedAt: '2026-05-21T00:00:00.000Z',
		});

		const data = await store.load('agent-session:["guild:1","default","case:1"]');
		const entry = data?.entries.find((item) => item.type === 'message' && item.message.role === 'user');
		expect(entry).toMatchObject({ type: 'message', source: 'dispatch', dispatch: { dispatchId: 'dispatch-1', targetAgent: 'moderator', agent: 'moderator', id: 'guild:1', session: 'case:1', acceptedAt: '2026-05-21T00:00:00.000Z', input: { z: 1, a: { b: 2, a: 1 } } } });
		const text = ((entry as any)?.message.content[0]?.text ?? '') as string;
		expect(text).toContain('[Dispatch Input]');
		expect(text).toContain('dispatchId: dispatch-1');
		expect(text).toContain('input:\n{\n  "a": {\n    "a": 1,\n    "b": 2\n  },\n  "z": 1\n}');
	});
});

function assistantMessage(): AgentMessage {
	return { role: 'assistant', content: [{ type: 'text', text: 'processed' }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as AgentMessage;
}

function fakeDispatchHarness(sessions: string[], processed: DispatchInput[]): FlueHarness {
	return {
		name: 'default',
		session: async (name?: string) => {
			const sessionName = name ?? 'default';
			sessions.push(sessionName);
			return { name: sessionName, processDispatchInput: async (input: DispatchInput) => { processed.push(input); } } as FlueSession & { processDispatchInput(input: DispatchInput): Promise<void> };
		},
		sessions: {} as never,
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
	};
}

function createTestContext(id: string, runId: string | undefined, payload: unknown, req: Request, initialEventIndex?: number) {
	return createFlueContext({ id, runId, payload, env: {}, req, initialEventIndex, agentConfig: testAgentConfig(), createDefaultEnv: async () => fakeEnv(), defaultStore: new InMemorySessionStore() });
}

function testAgentConfig(): AgentConfig {
	return { systemPrompt: '', skills: {}, subagents: {}, model: { id: 'test-model', provider: 'test', api: 'test' } as never, resolveModel: () => ({ id: 'test-model', provider: 'test', api: 'test' }) as never };
}

function fakeEnv(): SessionEnv {
	return {
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }), readFile: async () => '', readFileBuffer: async () => new Uint8Array(), writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }), readdir: async () => [], exists: async () => false, mkdir: async () => {}, rm: async () => {}, cwd: '/', resolvePath: (path) => path,
	};
}
