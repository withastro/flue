import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
	createAgentDispatchProcessor,
	createFlueContext,
	configureFlueRuntime,
	InMemoryDispatchQueue,
	InMemorySessionStore,
	receiveExternalDelivery,
	type DispatchInput,
} from '../src/internal.ts';
import { createAgent } from '../src/agent-definition.ts';
import { Harness } from '../src/harness.ts';
import type { AgentConfig, FlueHarness, FlueSession, SessionEnv } from '../src/types.ts';

describe('external delivery fan-out', () => {
	it('invokes every receive handler subscribed to the delivery channel', async () => {
		const calls: Array<{ agent: string; deliveryId: string }> = [];

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				moderator: async ({ delivery }) => calls.push({ agent: 'moderator', deliveryId: delivery.id }),
				audit: async ({ delivery }) => calls.push({ agent: 'audit', deliveryId: delivery.id }),
				ignored: async ({ delivery }) => calls.push({ agent: 'ignored', deliveryId: delivery.id }),
			},
			manifest: {
				agents: [
					{ name: 'moderator', channels: { discord: true }, receive: true, created: true },
					{ name: 'audit', channels: { discord: true, gchat: true }, receive: true, created: true },
					{ name: 'ignored', channels: { gchat: true }, receive: true, created: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: { text: 'hello' },
		});

		expect(result.invoked).toEqual(['moderator', 'audit']);
		expect(calls).toEqual([
			{ agent: 'moderator', deliveryId: 'evt-1' },
			{ agent: 'audit', deliveryId: 'evt-1' },
		]);
	});

	it('passes a caller-provided dispatch function into receive handlers', async () => {
		const dispatches: DispatchInput[] = [];
		const queue = new InMemoryDispatchQueue({
			process(input) {
				dispatches.push(input);
			},
		});

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
		});

		await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]).toMatchObject({
			deliveryId: 'evt-1',
			sourceAgent: 'moderator',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { type: 'flagged' },
		});
		expect(dispatches[0]?.dispatchId).toEqual(expect.any(String));
		expect(dispatches[0]?.acceptedAt).toEqual(expect.any(String));
	});

	it('accepts zero, many, and cross-agent dispatches from one delivery', async () => {
		const dispatches: DispatchInput[] = [];
		const queue = new InMemoryDispatchQueue({
			process(input) {
				dispatches.push(input);
			},
		});

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				observer: async () => {},
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'first' } });
					await dispatch({ agent: 'audit', id: 'account:1', session: 'event:1', input: { type: 'audit' } });
				},
			},
			manifest: {
				agents: [
					{ name: 'observer', channels: { discord: true }, receive: true, created: true },
					{ name: 'moderator', channels: { discord: true }, receive: true, created: true },
					{ name: 'audit', channels: { gchat: true }, receive: true, created: true },
				],
			},
		});

		const result = await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(result.errors).toEqual([]);
		expect(result.invoked).toEqual(['observer', 'moderator']);
		expect(dispatches).toHaveLength(2);
		expect(dispatches.map((dispatch) => dispatch.targetAgent)).toEqual(['moderator', 'audit']);
		expect(dispatches.map((dispatch) => dispatch.sourceAgent)).toEqual(['moderator', 'moderator']);
	});

	it('snapshots dispatch input at admission time', async () => {
		const dispatches: DispatchInput[] = [];
		const input = { nested: { count: 1 } };
		const queue = new InMemoryDispatchQueue({
			process(dispatch) {
				dispatches.push(dispatch);
			},
		});

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input });
					input.nested.count = 2;
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
		});

		await receiveExternalDelivery(
			{ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} },
			{ dispatchQueue: queue },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dispatches[0]?.input).toEqual({ nested: { count: 1 } });
	});

	it('isolates receive failures per subscribed agent', async () => {
		const calls: string[] = [];

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				bad: async () => {
					throw new Error('boom');
				},
				good: async () => {
					calls.push('good');
				},
			},
			manifest: {
				agents: [
					{ name: 'bad', channels: { discord: true }, receive: true, created: true },
					{ name: 'good', channels: { discord: true }, receive: true, created: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['bad', 'good']);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.agent).toBe('bad');
		expect(calls).toEqual(['good']);
	});

	it('passes an isolated delivery clone to each subscribed receive handler', async () => {
		const secondHandlerData: unknown[] = [];

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				mutator: async ({ delivery }) => {
					(delivery.data as { text: string }).text = 'mutated';
					delivery.id = 'mutated-id';
				},
				observer: async ({ delivery }) => {
					secondHandlerData.push({ id: delivery.id, data: delivery.data });
				},
			},
			manifest: {
				agents: [
					{ name: 'mutator', channels: { discord: true }, receive: true, created: true },
					{ name: 'observer', channels: { discord: true }, receive: true, created: true },
				],
			},
		});

		await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: { text: 'original' },
		});

		expect(secondHandlerData).toEqual([{ id: 'evt-1', data: { text: 'original' } }]);
	});

	it('rejects invalid dispatches inside the current receive handler', async () => {
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: '', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['moderator']);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.agent).toBe('moderator');
	});

	it('rejects dispatches when no dispatch queue is configured', async () => {
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toMatchObject({
			message: '[flue] dispatch() cannot be accepted because no dispatch queue is configured.',
		});
	});

	it('rejects missing target agents and non-serializable dispatch inputs', async () => {
		configureFlueRuntime({
			target: 'node',
			handlers: {},
			receiveHandlers: {
				missing: async ({ dispatch }) => {
					await dispatch({ agent: 'missing-target', id: 'x', session: 's', input: { ok: true } });
				},
				badInput: async ({ dispatch }) => {
					await dispatch({ id: 'x', session: 's', input: { fn: () => 'nope' } });
				},
			},
			manifest: {
				agents: [
					{ name: 'missing', channels: { discord: true }, receive: true, created: true },
					{ name: 'badInput', channels: { discord: true }, receive: true, created: true },
				],
			},
		});

		const result = await receiveExternalDelivery({
			id: 'evt-1',
			channel: 'discord',
			type: 'message.created',
			data: {},
		});

		expect(result.invoked).toEqual(['missing', 'badInput']);
		expect(result.errors.map((error) => error.agent)).toEqual(['missing', 'badInput']);
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
				ctx.subscribeEvent((event) => {
					events.push(event.type);
				});
				return ctx;
			},
		});

		await processor.process({
			dispatchId: 'dispatch-1',
			deliveryId: 'delivery-1',
			sourceAgent: 'router',
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
		expect(events).toEqual(['run_start', 'run_end']);
	});

	it('connects receiveExternalDelivery through dispatch, raw init, target session, and model execution', async () => {
		const processed: DispatchInput[] = [];
		const sessions: string[] = [];
		const queue = new InMemoryDispatchQueue(createAgentDispatchProcessor({
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
				return ctx;
			},
		}));

		configureFlueRuntime({
			target: 'node',
			handlers: {},
			dispatchQueue: queue,
			receiveHandlers: {
				moderator: async ({ dispatch }) => {
					await dispatch({ id: 'guild:1', session: 'case:1', input: { type: 'flagged' } });
				},
			},
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
		});

		await receiveExternalDelivery({ id: 'evt-1', channel: 'discord', type: 'message.created', data: {} });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(sessions).toEqual(['case:1']);
		expect(processed).toHaveLength(1);
		expect(processed[0]).toMatchObject({
			deliveryId: 'evt-1',
			sourceAgent: 'moderator',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { type: 'flagged' },
		});
	});

	it('renders dispatched input deterministically and preserves structured metadata', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness('guild:1', 'default', testAgentConfig(), fakeEnv(), store);
		const session = await harness.session('case:1');
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[] };
			prompt: (text: string) => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		agent.prompt = async (text: string) => {
			agent.state.messages.push(
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'synthetic preface' }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				} as AgentMessage,
				{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage,
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'processed' }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				} as AgentMessage,
			);
		};
		agent.waitForIdle = async () => {};

		await (session as FlueSession & { processDispatchInput(input: DispatchInput): PromiseLike<unknown> }).processDispatchInput({
			dispatchId: 'dispatch-1',
			deliveryId: 'delivery-1',
			sourceAgent: 'router',
			targetAgent: 'moderator',
			agent: 'moderator',
			id: 'guild:1',
			session: 'case:1',
			input: { z: 1, a: { b: 2, a: 1 } },
			acceptedAt: '2026-05-21T00:00:00.000Z',
		});

		const data = await store.load('agent-session:["guild:1","default","case:1"]');
		const dispatchEntry = data?.entries.find((entry) => entry.type === 'message' && entry.message.role === 'user');
		expect(data?.entries[0]).not.toHaveProperty('dispatch');
		expect(dispatchEntry).toMatchObject({
			type: 'message',
			source: 'dispatch',
			dispatch: {
				dispatchId: 'dispatch-1',
				deliveryId: 'delivery-1',
				sourceAgent: 'router',
				targetAgent: 'moderator',
				agent: 'moderator',
				id: 'guild:1',
				session: 'case:1',
				acceptedAt: '2026-05-21T00:00:00.000Z',
				input: { z: 1, a: { b: 2, a: 1 } },
			},
		});
		const text = ((dispatchEntry as any)?.message.content[0]?.text ?? '') as string;
		expect(text).toContain('[External Dispatch Input]');
		expect(text).toContain('dispatchId: dispatch-1');
		expect(text).toContain('input:\n{\n  "a": {\n    "a": 1,\n    "b": 2\n  },\n  "z": 1\n}');
	});
});

function fakeDispatchHarness(sessions: string[], processed: DispatchInput[]): FlueHarness {
	return {
		name: 'default',
		session: async (name?: string) => {
			const sessionName = name ?? 'default';
			sessions.push(sessionName);
			return {
				name: sessionName,
				processDispatchInput: async (input: DispatchInput) => {
					processed.push(input);
				},
			} as FlueSession & { processDispatchInput(input: DispatchInput): Promise<void> };
		},
		sessions: {} as never,
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
	};
}

function createTestContext(id: string, runId: string, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		agentConfig: testAgentConfig(),
		createDefaultEnv: async () => fakeEnv(),
		defaultStore: new InMemorySessionStore(),
	});
}

function testAgentConfig(): AgentConfig {
	return {
		systemPrompt: '',
		skills: {},
		subagents: {},
		model: { id: 'test-model', provider: 'test', api: 'test' } as never,
		resolveModel: () => ({ id: 'test-model', provider: 'test', api: 'test' }) as never,
	};
}

function fakeEnv(): SessionEnv {
	return {
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		cwd: '/',
		resolvePath: (path) => path,
	};
}
