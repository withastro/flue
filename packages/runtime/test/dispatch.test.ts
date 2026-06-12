import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent-definition.ts';
import { dispatch } from '../src/index.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	type DispatchInput,
	type DispatchQueue,
	InMemorySessionStore,
} from '../src/internal.ts';
import {
	createAgentSubmissionObserverRegistry,
	createAgentSubmissionSessionHandler,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
} from '../src/runtime/agent-submissions.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { generateSessionAffinityKey } from '../src/runtime/ids.ts';
import { createSessionStorageKey } from '../src/session-identity.ts';
import type { AgentConfig, SessionData } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

/** Minimal no-op dispatch queue stub for tests that only exercise dispatch() validation. */
function noopDispatchQueue(): DispatchQueue {
	return {
		async enqueue(input) {
			return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
		},
	};
}

afterEach(() => {
	resetFlueRuntimeForTests();
	for (const provider of providers.splice(0)) provider.unregister();
});

describe('createAgentSubmissionObserverRegistry()', () => {
	it('settles attached observers when event callbacks fail', async () => {
		const registry = createAgentSubmissionObserverRegistry();
		const attachment = registry.attach('direct:observer-failure', {
			onEvent: async () => {
				throw new Error('Socket disconnected');
			},
		});

		await expect(
			registry.publish('direct:observer-failure', { type: 'idle', instanceId: 'agent-1', v: 1, eventIndex: 0, timestamp: '2026-06-01T00:00:00.000Z' }),
		).resolves.toBeUndefined();
		registry.complete('direct:observer-failure', 'done');

		await expect(attachment.completion).resolves.toBe('done');
	});
});

describe('dispatch()', () => {
	it('rejects calls when the runtime has not been configured', async () => {
		await expect(
			dispatch({ agent: 'moderator', id: 'guild:unconfigured', input: { type: 'flagged' } }),
		).rejects.toThrow('dispatch() called before runtime was configured');
	});

	it('returns an admission receipt when a named agent dispatch is accepted', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		const receipt = await dispatch({
			agent: 'moderator',
			id: 'guild:admission',
			input: { type: 'flagged', reportId: 'report:admission' },
		});

		expect(receipt).toEqual({
			dispatchId: expect.any(String),
			acceptedAt: expect.any(String),
		});
	});

	it('resolves a discovered agent name when dispatch() receives a created agent target', async () => {
		const moderator = createAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			resolveDispatchAgentName: (candidate) => (candidate === moderator ? 'moderator' : undefined),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await dispatch(moderator, {
			id: 'guild:created',
			input: { type: 'flagged', reportId: 'report:created' },
		});

		expect(admitted).toMatchObject([
			{
				agent: 'moderator',
				id: 'guild:created',
				input: { type: 'flagged', reportId: 'report:created' },
			},
		]);
	});

	it('rejects a created agent target when the built application cannot resolve its identity', async () => {
		const localModerator = createAgent(() => ({ model: false }));
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			resolveDispatchAgentName: () => undefined,
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch(localModerator, {
				id: 'guild:local',
				input: { type: 'flagged', reportId: 'report:local' },
			}),
		).rejects.toThrow('not a discovered default-exported agent');
	});

	it('snapshots JSON-like input when dispatch() admits a payload', async () => {
		const admitted: DispatchInput[] = [];
		const payload = { type: 'flagged', report: { id: 'report:snapshot', count: 1 } };
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await dispatch({ agent: 'moderator', id: 'guild:snapshot', input: payload });
		payload.report.count = 2;

		expect(admitted[0]?.input).toEqual({
			type: 'flagged',
			report: { id: 'report:snapshot', count: 1 },
		});
	});

	it('rejects missing input when dispatch() receives an undefined payload', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:undefined-input', input: undefined }),
		).rejects.toThrow('requires an "input" payload');
	});

	it('rejects non-JSON-like input when dispatch() receives a function value', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:function-input',
				input: { type: 'flagged', callback: () => 'unsupported' },
			}),
		).rejects.toThrow('must not contain function values');
	});

	it('rejects non-JSON-like input when dispatch() receives a bigint value', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:bigint-input',
				input: { type: 'flagged', reportId: 1n },
			}),
		).rejects.toThrow('must not contain bigint values');
	});

	it('rejects non-JSON-like input when dispatch() receives a non-plain object', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({
				agent: 'moderator',
				id: 'guild:date-input',
				input: { type: 'flagged', acceptedAt: new Date('2026-06-01T00:00:00.000Z') },
			}),
		).rejects.toThrow('must contain only plain JSON objects');
	});

	it('rejects an unknown agent when dispatch() targets an unregistered name', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'missing', id: 'guild:unknown-agent', input: { type: 'flagged' } }),
		).rejects.toThrow('target agent "missing" is not registered');
	});

	it('rejects a blank agent instance id when dispatch() receives an id', async () => {
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: noopDispatchQueue(),
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: '  ', input: { type: 'flagged' } }),
		).rejects.toThrow('requires a non-empty "id" target agent instance id');
	});

	it('rejects calls when the runtime has no dispatch queue', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [{ name: 'moderator', transports: {}, created: true }] },
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:no-queue', input: { type: 'flagged' } }),
		).rejects.toThrow('no dispatch queue is configured');
	});
});

describe('dispatched session processing', () => {
	it('marks input application after configured persistence and before model processing begins', async () => {
		const order: string[] = [];
		const provider = createProvider();
		provider.setResponses([
			() => {
				order.push('provider');
				return fauxAssistantMessage('processed after marker');
			},
		]);
		const store = new InMemorySessionStore();
		const originalSave = store.save.bind(store);
		store.save = async (id, data) => {
			if (data.entries.some((entry) => entry.type === 'message' && entry.dispatch?.dispatchId === 'dispatch:input-marker-order')) {
				order.push('persist-input');
			}
			await originalSave(id, data);
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const input: DispatchInput = {
			dispatchId: 'dispatch:input-marker-order',
			agent: 'moderator',
			id: 'guild:input-marker-order',
			input: { type: 'flagged', reportId: 'report:input-marker-order' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			dispatchId: input.dispatchId,
			payload: input,
			env: {},
			req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store,
		});

		const submissionInput = createDispatchAgentSubmissionInput(input);
		await createAgentSubmissionSessionHandler(agent, submissionInput, (s) =>
			s.processSubmissionInput(submissionInput, {
				onInputApplied: () => {
					order.push('input-applied');
				},
			}),
		)(ctx);

		expect(order.indexOf('persist-input')).toBeLessThan(order.indexOf('input-applied'));
		expect(order.indexOf('input-applied')).toBeLessThan(order.indexOf('provider'));
	});

	it('persists plain direct submission input before marking input application and invoking the provider', async () => {
		const order: string[] = [];
		const provider = createProvider();
		provider.setResponses([
			() => {
				order.push('provider');
				return fauxAssistantMessage('processed direct input');
			},
		]);
		const store = new InMemorySessionStore();
		const originalSave = store.save.bind(store);
		store.save = async (id, data) => {
			if (data.entries.some((entry) => entry.type === 'message' && entry.directSubmissionId === 'direct:input-marker-order')) {
				order.push('persist-input');
			}
			await originalSave(id, data);
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId: 'direct:input-marker-order',
			agent: 'moderator',
			id: 'guild:direct-input-marker-order',
			payload: { message: 'Hello directly' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			payload: input.payload,
			env: {},
			req: new Request('http://flue.local/agents/moderator/guild:direct-input-marker-order', { method: 'POST' }),
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store,
		});

		await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.processSubmissionInput(input, {
				onInputApplied: () => {
					order.push('input-applied');
				},
			}),
		)(ctx);

		const data = await store.load(`agent-session:${JSON.stringify([input.id, 'default', 'default'])}`);
		expect(order.indexOf('persist-input')).toBeLessThan(order.indexOf('input-applied'));
		expect(order.indexOf('input-applied')).toBeLessThan(order.indexOf('provider'));
		expect(data?.entries[0]).toMatchObject({
			directSubmissionId: input.submissionId,
			message: { role: 'user', content: [{ type: 'text', text: 'Hello directly' }] },
		});
		expect(data?.entries[0]).not.toHaveProperty('dispatch');
	});

	it('persists one provider-visible terminal advisory when an interrupted submission cannot replay safely', async () => {
		const provider = createProvider();
		const store = new InMemorySessionStore();
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId: 'direct:terminal-advisory',
			agent: 'moderator',
			id: 'guild:terminal-advisory',
			payload: { message: 'Hello directly' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const createContext = () =>
			createFlueContext({
				id: input.id,
				payload: input.payload,
				env: {},
				req: new Request('http://flue.local/agents/moderator/guild:terminal-advisory', { method: 'POST' }),
				agentConfig: testAgentConfig(),
				createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
				defaultStore: store,
			});
		const terminal = {
			submissionId: input.submissionId,
			kind: 'direct' as const,
			reason: 'interrupted_after_input_application' as const,
			message: 'Provider replay was not attempted because prior execution could not be proven safe.',
		};

		await createAgentSubmissionSessionHandler(agent, input, (s) => s.recordSubmissionTerminal(terminal))(createContext());
		await createAgentSubmissionSessionHandler(agent, input, (s) => s.recordSubmissionTerminal(terminal))(createContext());

		const data = await store.load(`agent-session:${JSON.stringify([input.id, 'default', 'default'])}`);
		expect(data?.entries).toHaveLength(1);
		expect(data?.entries[0]).toMatchObject({
			submissionTerminal: {
				submissionId: input.submissionId,
				kind: 'direct',
				reason: 'interrupted_after_input_application',
			},
			message: {
				role: 'signal',
				type: 'submission_interrupted',
				content: 'Provider replay was not attempted because prior execution could not be proven safe.',
			},
		});
	});

	it('classifies a completed canonical direct response without model replay', async () => {
		const provider = createProvider();
		const store = new InMemorySessionStore();
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId: 'direct:inspect-completed',
			agent: 'moderator',
			id: 'guild:direct-inspect-completed',
			payload: { message: 'Hello directly' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const timestamp = '2026-06-01T00:00:00.000Z';
		await store.save(`agent-session:${JSON.stringify([input.id, 'default', 'default'])}`, {
			version: 6,
			affinityKey: 'aff_01KT3P3GZGFBCKHKMQ11A7H2HW',
			taskSessions: [],
			entries: [
				{
					type: 'message',
					id: 'direct-input',
					parentId: null,
					timestamp,
					message: { role: 'user', content: [{ type: 'text', text: input.payload.message }], timestamp: 0 },
					directSubmissionId: input.submissionId,
				},
				{
					type: 'message',
					id: 'assistant-response',
					parentId: 'direct-input',
					timestamp,
					message: fauxAssistantMessage('persisted response'),
				},
			],
			leafId: 'assistant-response',
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: input.id,
			payload: input.payload,
			env: {},
			req: new Request('http://flue.local/agents/moderator/guild:direct-inspect-completed', { method: 'POST' }),
			agentConfig: testAgentConfig(),
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store,
		});

		await expect(createAgentSubmissionSessionHandler(agent, input, (s) => s.inspectSubmissionInput(input))(ctx)).resolves.toBe('completed');
		expect(provider.state.callCount).toBe(0);
	});

	it('classifies a completed canonical dispatch response without model replay', async () => {
		const provider = createProvider();
		const store = new InMemorySessionStore();
		const input: DispatchInput = {
			dispatchId: 'dispatch:inspect-completed',
			agent: 'moderator',
			id: 'guild:inspect-completed',
			input: { type: 'flagged', reportId: 'report:inspect-completed' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const timestamp = '2026-06-01T00:00:00.000Z';
		await store.save(`agent-session:${JSON.stringify([input.id, 'default', 'default'])}`, {
			version: 6,
			affinityKey: 'aff_01KT3P3GZGFBCKHKMQ11A7H2HW',
			taskSessions: [],
			entries: [
				{
					type: 'message',
					id: 'dispatch-input',
					parentId: null,
					timestamp,
					message: { role: 'user', content: [{ type: 'text', text: 'persisted dispatch' }], timestamp: 0 },
					dispatch: { dispatchId: input.dispatchId },
				},
				{
					type: 'message',
					id: 'assistant-response',
					parentId: 'dispatch-input',
					timestamp,
					message: fauxAssistantMessage('persisted response'),
				},
			],
			leafId: 'assistant-response',
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: input.id,
			dispatchId: input.dispatchId,
			payload: input,
			env: {},
			req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: testAgentConfig(),
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store,
		});

		await expect(createAgentSubmissionSessionHandler(agent, createDispatchAgentSubmissionInput(input), (s) => s.inspectSubmissionInput(createDispatchAgentSubmissionInput(input)))(ctx)).resolves.toBe('completed');
		expect(provider.state.callCount).toBe(0);
	});

	it('classifies an incomplete canonical dispatch response without model replay', async () => {
		const provider = createProvider();
		const store = new InMemorySessionStore();
		const input: DispatchInput = {
			dispatchId: 'dispatch:inspect-applied',
			agent: 'moderator',
			id: 'guild:inspect-applied',
			input: { type: 'flagged', reportId: 'report:inspect-applied' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const timestamp = '2026-06-01T00:00:00.000Z';
		await store.save(`agent-session:${JSON.stringify([input.id, 'default', 'default'])}`, {
			version: 6,
			affinityKey: 'aff_01KT3P3GZGFBCKHKMQ11A7H2HW',
			taskSessions: [],
			entries: [
				{
					type: 'message',
					id: 'dispatch-input',
					parentId: null,
					timestamp,
					message: { role: 'user', content: [{ type: 'text', text: 'persisted dispatch' }], timestamp: 0 },
					dispatch: { dispatchId: input.dispatchId },
				},
			],
			leafId: 'dispatch-input',
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: input.id,
			dispatchId: input.dispatchId,
			payload: input,
			env: {},
			req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: testAgentConfig(),
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store,
		});

		await expect(createAgentSubmissionSessionHandler(agent, createDispatchAgentSubmissionInput(input), (s) => s.inspectSubmissionInput(createDispatchAgentSubmissionInput(input)))(ctx)).resolves.toBe('uncertain');
		expect(provider.state.callCount).toBe(0);
	});
});

describe('repairInterruptedToolCalls()', () => {
	function interruptedSessionData(
		dispatchId: string,
		instanceId: string,
		sessionName: string,
		toolCalls: Array<{ id: string; name: string }>,
		settledToolCallIds: string[] = [],
	): { data: import('../src/types.ts').SessionData; storageKey: string } {
		const now = new Date().toISOString();
		const entries: import('../src/types.ts').SessionEntry[] = [];
		let leafId: string | null = null;
		let nextId = 1;
		const makeId = () => `e${nextId++}`;

		const userId = makeId();
		entries.push({
			type: 'message',
			id: userId,
			parentId: leafId,
			timestamp: now,
			message: { role: 'user', content: 'Run the tools.', timestamp: Date.now() } as any,
			dispatch: { dispatchId },
		});
		leafId = userId;

		const assistantId = makeId();
		entries.push({
			type: 'message',
			id: assistantId,
			parentId: leafId,
			timestamp: now,
			message: {
				role: 'assistant',
				content: toolCalls.map((tc) => ({
					type: 'toolCall',
					id: tc.id,
					name: tc.name,
					arguments: {},
				})),
				stopReason: 'toolUse',
				api: 'test',
				provider: 'test',
				model: 'test',
				usage: { inputTokens: 0, outputTokens: 0 },
				timestamp: Date.now(),
			} as any,
		});
		leafId = assistantId;

		for (const tcId of settledToolCallIds) {
			const tc = toolCalls.find((t) => t.id === tcId);
			if (!tc) continue;
			const resultId = makeId();
			entries.push({
				type: 'message',
				id: resultId,
				parentId: leafId,
				timestamp: now,
				message: {
					role: 'toolResult',
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: 'text', text: `Result for ${tc.name}` }],
					isError: false,
					timestamp: Date.now(),
				} as any,
			});
			leafId = resultId;
		}

		return {
			data: {
				version: 6,
				affinityKey: generateSessionAffinityKey(),
				entries,
				leafId,
				taskSessions: [],
				metadata: {},
				createdAt: now,
				updatedAt: now,
			},
			storageKey: createSessionStorageKey(instanceId, 'default', sessionName),
		};
	}

	/** Walk the active path from the leaf to the root, returning tool results in chronological order. */
	function activePathToolResults(
		sessionData: SessionData,
	): Array<{ toolCallId: string; isError: boolean; text: string }> {
		const results: Array<{ toolCallId: string; isError: boolean; text: string }> = [];
		let currentId = sessionData.leafId;
		while (currentId) {
			const entry = sessionData.entries.find((e) => e.id === currentId);
			if (!entry) break;
			if (entry.type === 'message' && entry.message.role === 'toolResult') {
				const first = entry.message.content[0];
				results.unshift({
					toolCallId: entry.message.toolCallId,
					isError: entry.message.isError,
					text: first?.type === 'text' ? first.text : '',
				});
			}
			currentId = entry.parentId;
		}
		return results;
	}

	it('appends synthetic interrupted results for all unresolved tool calls', async () => {
		const { sqlite } = await import('../src/node/agent-execution-store.ts');
		const adapter = sqlite();
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		const provider = createProvider();
		const tc1 = { id: `tc:a-${crypto.randomUUID()}`, name: 'lookup' };
		const tc2 = { id: `tc:b-${crypto.randomUUID()}`, name: 'search' };

		// Pre-populate with interrupted state: assistant requested 2 tools, no results persisted.
		const { data, storageKey } = interruptedSessionData('dispatch:repair-all', 'guild:repair', 'default', [tc1, tc2]);
		await store.sessions.save(storageKey, data);

		const submissionInput = {
			dispatchId: 'dispatch:repair-all',
			kind: 'dispatch' as const,
			submissionId: 'dispatch:repair-all',
			agent: 'moderator',
			id: 'guild:repair',
			input: { type: 'flagged' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: submissionInput.id, dispatchId: submissionInput.dispatchId, payload: submissionInput,
			env: {}, req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store.sessions,
			submissionStore: store.submissions,
		});

		const repairedLeafId = await createAgentSubmissionSessionHandler(
			agent,
			submissionInput,
			(s) => s.repairInterruptedToolCalls(submissionInput, { toolCalls: [{ type: 'toolCall', ...tc1 }, { type: 'toolCall', ...tc2 }] }),
		)(ctx);

		expect(repairedLeafId).toBeTruthy();

		// Walk the active path to find tool results in order.
		const sessionData = await store.sessions.load(storageKey);
		if (!sessionData) throw new Error('Expected repaired session data.');
		const activeResults = activePathToolResults(sessionData);

		expect(activeResults).toHaveLength(2);
		// Both are synthetic interrupted results in original tool-call order.
		expect(activeResults.map((r) => r.toolCallId)).toEqual([tc1.id, tc2.id]);
		for (const r of activeResults) {
			expect(r.isError).toBe(true);
			expect(JSON.parse(r.text)).toMatchObject({ type: 'interrupted' });
		}
	});

	it('preserves already-settled results and only repairs missing ones', async () => {
		const { sqlite } = await import('../src/node/agent-execution-store.ts');
		const adapter = sqlite();
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		const provider = createProvider();
		const tc1 = { id: `tc:settled-${crypto.randomUUID()}`, name: 'fast_tool' };
		const tc2 = { id: `tc:missing-${crypto.randomUUID()}`, name: 'slow_tool' };

		// Pre-populate: tc1 has a result, tc2 does not.
		const { data, storageKey } = interruptedSessionData('dispatch:repair-partial', 'guild:repair', 'default', [tc1, tc2], [tc1.id]);
		await store.sessions.save(storageKey, data);

		const submissionInput = {
			dispatchId: 'dispatch:repair-partial',
			kind: 'dispatch' as const,
			submissionId: 'dispatch:repair-partial',
			agent: 'moderator',
			id: 'guild:repair',
			input: { type: 'flagged' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: submissionInput.id, dispatchId: submissionInput.dispatchId, payload: submissionInput,
			env: {}, req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store.sessions,
			submissionStore: store.submissions,
		});

		const repairedLeafId = await createAgentSubmissionSessionHandler(
			agent,
			submissionInput,
			(s) => s.repairInterruptedToolCalls(submissionInput, { toolCalls: [{ type: 'toolCall', ...tc1 }, { type: 'toolCall', ...tc2 }] }),
		)(ctx);

		expect(repairedLeafId).toBeTruthy();

		// Walk the active path to find tool results in order.
		const sessionData = await store.sessions.load(storageKey);
		if (!sessionData) throw new Error('Expected repaired session data.');
		const activeResults = activePathToolResults(sessionData);

		// Two results in original tool-call order.
		expect(activeResults).toHaveLength(2);
		expect(activeResults[0]?.toolCallId).toBe(tc1.id);
		expect(activeResults[0]?.isError).toBe(false); // Settled result preserved.
		expect(activeResults[1]?.toolCallId).toBe(tc2.id);
		expect(activeResults[1]?.isError).toBe(true); // Synthetic interrupted.
	});

	it('produces correctly ordered results when a non-first tool is the only settled one', async () => {
		const { sqlite } = await import('../src/node/agent-execution-store.ts');
		const adapter = sqlite();
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		const provider = createProvider();
		const tc1 = { id: `tc:first-${crypto.randomUUID()}`, name: 'tool_a' };
		const tc2 = { id: `tc:second-${crypto.randomUUID()}`, name: 'tool_b' };
		const tc3 = { id: `tc:third-${crypto.randomUUID()}`, name: 'tool_c' };

		// Pre-populate: only tc2 (the middle tool) has a settled result.
		const { data, storageKey } = interruptedSessionData(
			'dispatch:repair-order', 'guild:repair', 'default',
			[tc1, tc2, tc3], [tc2.id],
		);
		await store.sessions.save(storageKey, data);

		const submissionInput = {
			dispatchId: 'dispatch:repair-order',
			kind: 'dispatch' as const,
			submissionId: 'dispatch:repair-order',
			agent: 'moderator',
			id: 'guild:repair',
			input: { type: 'flagged' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: submissionInput.id, dispatchId: submissionInput.dispatchId, payload: submissionInput,
			env: {}, req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store.sessions,
			submissionStore: store.submissions,
		});

		const repairedLeafId = await createAgentSubmissionSessionHandler(
			agent,
			submissionInput,
			(s) => s.repairInterruptedToolCalls(submissionInput, { toolCalls: [{ type: 'toolCall', ...tc1 }, { type: 'toolCall', ...tc2 }, { type: 'toolCall', ...tc3 }] }),
		)(ctx);

		expect(repairedLeafId).toBeTruthy();

		const sessionData = await store.sessions.load(storageKey);
		if (!sessionData) throw new Error('Expected repaired session data.');
		// Walk from the leaf backwards to find the tool results in the active path.
		const resultEntries = activePathToolResults(sessionData);

		// Results must be in original tool-call order: [tc1, tc2, tc3].
		expect(resultEntries.map((r) => r.toolCallId)).toEqual([tc1.id, tc2.id, tc3.id]);
		// tc1 and tc3 are synthetic (interrupted), tc2 is the original settled result.
		expect(resultEntries[0]?.isError).toBe(true);
		expect(resultEntries[1]?.isError).toBe(false);
		expect(resultEntries[2]?.isError).toBe(true);
	});

	it('returns undefined when all tool calls already have results', async () => {
		const { sqlite } = await import('../src/node/agent-execution-store.ts');
		const adapter = sqlite();
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		const provider = createProvider();
		const tc1 = { id: `tc:done-${crypto.randomUUID()}`, name: 'lookup' };

		// Pre-populate: tc1 has a result.
		const { data, storageKey } = interruptedSessionData('dispatch:repair-noop', 'guild:repair', 'default', [tc1], [tc1.id]);
		await store.sessions.save(storageKey, data);

		const submissionInput = {
			dispatchId: 'dispatch:repair-noop',
			kind: 'dispatch' as const,
			submissionId: 'dispatch:repair-noop',
			agent: 'moderator',
			id: 'guild:repair',
			input: { type: 'flagged' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const agent = createAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const ctx = createFlueContext({
			id: submissionInput.id, dispatchId: submissionInput.dispatchId, payload: submissionInput,
			env: {}, req: new Request('http://flue.local/_dispatch', { method: 'POST' }),
			agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: store.sessions,
			submissionStore: store.submissions,
		});

		const repairedLeafId = await createAgentSubmissionSessionHandler(
			agent,
			submissionInput,
			(s) => s.repairInterruptedToolCalls(submissionInput, { toolCalls: [{ type: 'toolCall', ...tc1 }] }),
		)(ctx);

		expect(repairedLeafId).toBeUndefined();
	});
});

function testAgentConfig(): AgentConfig {
	return {
		systemPrompt: '',
		skills: {},
		subagents: {},
		model: { id: 'test-model', provider: 'test', api: 'test' } as never,
		resolveModel: () => ({ id: 'test-model', provider: 'test', api: 'test' }) as never,
	};
}

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `dispatch-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}
