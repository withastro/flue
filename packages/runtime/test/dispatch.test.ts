import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import { OperationFailedError } from '../src/errors.ts';
import { dispatch } from '../src/index.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	type DispatchInput,
	type DispatchQueue,
} from '../src/internal.ts';
import {
	createAgentSubmissionObserverRegistry,
	createAgentSubmissionSessionHandler,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
} from '../src/runtime/agent-submissions.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { generateSessionAffinityKey } from '../src/runtime/ids.ts';
import type { AgentConfig } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { agentRecord, nodeRuntime } from './helpers/runtime-config.ts';

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

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `dispatch-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

describe('createAgentSubmissionObserverRegistry()', () => {
	it('settles attached observers when event callbacks fail', async () => {
		const registry = createAgentSubmissionObserverRegistry();
		const attachment = registry.attach('direct:observer-failure', {
			onEvent: async () => {
				throw new Error('Socket disconnected');
			},
		});

		await expect(
			registry.publish('direct:observer-failure', {
				type: 'idle',
				instanceId: 'agent-1',
				v: 3,
				eventIndex: 0,
				timestamp: '2026-06-01T00:00:00.000Z',
			}),
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
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
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

	it('resolves a discovered agent name when dispatch() receives an agent definition target', async () => {
		const moderator = defineAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			...nodeRuntime(),
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			agents: [agentRecord('moderator', { definition: moderator })],
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

	it('rejects an agent definition target when the built application cannot resolve its identity', async () => {
		const localModerator = defineAgent(() => ({ model: false }));
		configureFlueRuntime({
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
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
			...nodeRuntime(),
			dispatchQueue: {
				async enqueue(input) {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			agents: [agentRecord('moderator')],
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
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
		});

		await expect(
			dispatch({ agent: 'moderator', id: 'guild:undefined-input', input: undefined }),
		).rejects.toThrow('requires an "input" payload');
	});

	it('rejects non-JSON-like input when dispatch() receives a function value', async () => {
		configureFlueRuntime({
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
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
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
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
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
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
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
		});

		await expect(
			dispatch({ agent: 'missing', id: 'guild:unknown-agent', input: { type: 'flagged' } }),
		).rejects.toThrow('target agent "missing" is not registered');
	});

	it('rejects a blank agent instance id when dispatch() receives an id', async () => {
		configureFlueRuntime({
			...nodeRuntime(),
			dispatchQueue: noopDispatchQueue(),
			agents: [agentRecord('moderator')],
		});

		await expect(
			dispatch({ agent: 'moderator', id: '  ', input: { type: 'flagged' } }),
		).rejects.toThrow('requires a non-empty "id" target agent instance id');
	});
});

describe('dispatched session processing', () => {
	it('does not commit the journal when a turn ends aborted', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage('partial output collected before the abort', {
				stopReason: 'aborted',
				errorMessage: 'Request was aborted',
			}),
		]);
		const submissionStore = {} as import('../src/agent-execution-store.ts').AgentSubmissionStore;
		const journalCommits: string[] = [];
		const agent = defineAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId: 'direct:aborted-turn-no-commit',
			agent: 'moderator',
			id: 'guild:aborted-turn-no-commit',
			payload: { message: 'Hello directly' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			env: {},
			req: new Request('http://flue.local/agents/moderator/guild:aborted-turn-no-commit', {
				method: 'POST',
			}),
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			submissionStore,
		});

		await expect(
			createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.processSubmissionInput(input, {
					submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
					journal: {
						committed: async () => {
							journalCommits.push('committed');
						},
						checkpointReady: async () => {
							journalCommits.push('checkpoint-ready');
						},
					},
				}),
			)(ctx),
		).rejects.toBeInstanceOf(OperationFailedError);

		expect(journalCommits).toEqual([]);
	});

	it('does not commit the journal when a turn ends with a model error', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid_api_key' }),
		]);
		const submissionStore = {} as import('../src/agent-execution-store.ts').AgentSubmissionStore;
		const journalCommits: string[] = [];
		const agent = defineAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		}));
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId: 'direct:error-turn-no-commit',
			agent: 'moderator',
			id: 'guild:error-turn-no-commit',
			payload: { message: 'Hello directly' },
			acceptedAt: '2026-06-01T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			env: {},
			req: new Request('http://flue.local/agents/moderator/guild:error-turn-no-commit', {
				method: 'POST',
			}),
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			submissionStore,
		});

		await expect(
			createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.processSubmissionInput(input, {
					submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
					journal: {
						committed: async () => {
							journalCommits.push('committed');
						},
						checkpointReady: async () => {
							journalCommits.push('checkpoint-ready');
						},
					},
				}),
			)(ctx),
		).rejects.toBeInstanceOf(OperationFailedError);

		expect(journalCommits).toEqual([]);
	});

});
