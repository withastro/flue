import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeDurableObjectStorage } from '../node/agent-execution-store.ts';
import type { Agent } from '../types.ts';
import {
	type CloudflareAgentRuntime,
	type CloudflareMachineContext,
	createCloudflareAgentRuntime,
	FLUE_CONVERSATION_TASK,
} from './agent-coordinator.ts';

// The coordinator re-declares the Agents SDK surface structurally, so the
// fakes below are typed off it rather than off the unpublished `agents`
// package.
type AgentInstance = Parameters<CloudflareAgentRuntime['attach']>[0];
type AgentTasks = AgentInstance['tasks'];
type TaskRunState = Awaited<ReturnType<AgentTasks['run']>>['state'];
type RuntimeOptions = Parameters<typeof createCloudflareAgentRuntime>[0];

const AGENT_NAME = 'coordinated';
const INSTANCE_NAME = 'instance-1';
const CONVERSATION_RUN_ID = 'flue:conversation';

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The engine the coordinator runs on, faked at the three `Agent.tasks`
 * methods and the machine context its phases receive. Mirrors
 * agents-machine-primitive 9bc6cda9 (`packages/agents/src/state-machine/types.ts`):
 * `run` at an existing runId joins instead of starting, `send` deduplicates
 * by `requestId` — a repeat writes no row — `reopen` returns a failed run to
 * pending, `receiveAll()` with no `within` parks until a send arrives, and
 * `peekAll`/`withdraw` see the queued items.
 */
function createEngineFake(options: { runState?: TaskRunState } = {}) {
	const runs: Array<{ definition: string; runId: string }> = [];
	const sends: Array<{ kind: string; requestId: string }> = [];
	const mailbox: Array<{ key: string; kind: string; payload: unknown }> = [];
	const reopened: string[] = [];
	let runState = options.runState;
	let notifyArrival: (() => void) | undefined;

	const drain = () => mailbox.splice(0, mailbox.length);

	const tasks: AgentTasks = {
		async run(definition, _input, runOptions) {
			runs.push({ definition, runId: runOptions.runId });
			if (runState === undefined) {
				runState = 'running';
				return { accepted: true, state: runState };
			}
			return { accepted: false, state: runState };
		},
		async send(_runId, payload, sendOptions) {
			sends.push({ kind: sendOptions.kind, requestId: sendOptions.requestId });
			if (mailbox.some((item) => item.key === sendOptions.requestId)) return { accepted: false };
			mailbox.push({ key: sendOptions.requestId, kind: sendOptions.kind, payload });
			notifyArrival?.();
			notifyArrival = undefined;
			return { accepted: true };
		},
		async reopen(runId) {
			reopened.push(runId);
			runState = 'pending';
			return true;
		},
	};

	const ctx: CloudflareMachineContext = {
		signal: new AbortController().signal,
		cancelling: null,
		receiveAll(filter) {
			return new Promise((resolve) => {
				if (mailbox.length > 0) {
					resolve(drain());
					return;
				}
				notifyArrival = () => resolve(drain());
				if (filter?.within !== undefined) {
					setTimeout(() => {
						notifyArrival = undefined;
						resolve([]);
					}, filter.within);
				}
			});
		},
		peekAll: () => mailbox.map((item) => ({ key: item.key })),
		withdraw(key) {
			const index = mailbox.findIndex((item) => item.key === key);
			if (index < 0) return false;
			mailbox.splice(index, 1);
			return true;
		},
		heartbeat: () => {},
		aborted: (reason) => ({ aborted: reason }),
	};

	return { tasks, ctx, runs, sends, mailbox, reopened };
}

/**
 * A coordinator bound to a Durable-Object-shaped `node:sqlite` storage, built
 * the way the generated entry builds it: `prepare` before `attach`, with the
 * prepared stores kept so a test can seed the ledger directly.
 */
function createHarness(
	options: {
		runState?: TaskRunState;
		tasks?: unknown;
		agents?: RuntimeOptions['agents'];
	} = {},
) {
	const engine = createEngineFake({ runState: options.runState });
	const storage = createNodeDurableObjectStorage(new DatabaseSync(':memory:'));
	const instance: AgentInstance = {
		name: INSTANCE_NAME,
		env: {},
		ctx: { id: { toString: () => 'durable-object-id' }, storage },
		tasks: (options.tasks ?? engine.tasks) as AgentTasks,
	};
	const runtime = createCloudflareAgentRuntime({
		agents: options.agents ?? [{ name: AGENT_NAME, agent: (() => null) as unknown as Agent }],
		createContext: () => {
			throw new Error('These tests never reach a path that renders the agent.');
		},
		runWithInstanceContext: (_instance, _agentName, callback) => callback(),
	});
	const prepared = runtime.prepare({
		storage,
		className: 'FlueCoordinatedAgent',
		agentName: AGENT_NAME,
	});
	runtime.attach(instance, prepared);
	return { engine, instance, runtime, submissions: prepared.submissionStore };
}

function dispatchBody(submissionId: string) {
	return {
		submissionId,
		agent: AGENT_NAME,
		id: INSTANCE_NAME,
		message: { kind: 'user' as const, body: 'hello' },
		acceptedAt: new Date(1_700_000_000_000).toISOString(),
	};
}

function dispatchRequest(body: unknown): Request {
	return new Request('https://durable-object.invalid/__flue/internal/dispatch', {
		method: 'POST',
		body: JSON.stringify(body),
	});
}

/** Seed one queued, claimable ledger row without going through admission. */
async function seedQueuedSubmission(
	submissions: ReturnType<typeof createHarness>['submissions'],
	submissionId: string,
) {
	await submissions.admitDispatch(dispatchBody(submissionId));
	await submissions.markSubmissionCanonicalReady(submissionId);
}

it('wakes the conversation once per admitted submission', async () => {
	const { engine, instance, runtime } = createHarness();
	const body = dispatchBody('sub-1');

	const response = await runtime.onRequest(instance, dispatchRequest(body));

	expect(response?.status).toBe(200);
	expect(engine.runs).toEqual([{ definition: FLUE_CONVERSATION_TASK, runId: CONVERSATION_RUN_ID }]);
	expect(engine.mailbox).toEqual([
		{ key: 'submission:sub-1', kind: 'submission', payload: { kind: 'submission', key: 'sub-1' } },
	]);

	// A replay re-admits the same row and wakes under the same key, so the
	// engine's `requestId` deduplication collapses it to the one item.
	const replay = await runtime.onRequest(instance, dispatchRequest(body));

	expect(replay?.status).toBe(200);
	expect(engine.sends.map((send) => send.requestId)).toEqual([
		'submission:sub-1',
		'submission:sub-1',
	]);
	expect(engine.mailbox).toHaveLength(1);
});

it('recovers from any recorded conversation failure while work is unsettled', async () => {
	const { engine, instance, runtime, submissions } = createHarness();
	await seedQueuedSubmission(submissions, 'sub-1');

	await runtime.onTaskError(
		instance,
		Object.assign(new Error('x'), { name: 'StateMachineNoProgressError' }),
	);

	expect(engine.mailbox).toHaveLength(1);
	expect(engine.mailbox[0]?.kind).toBe('wake');
	expect(engine.mailbox[0]?.key).toMatch(/^wake:recover:\d+$/);
});

it('stays quiet on a recorded conversation failure with nothing unsettled', async () => {
	const { engine, instance, runtime } = createHarness();

	await runtime.onTaskError(
		instance,
		Object.assign(new Error('x'), { name: 'StateMachineNoProgressError' }),
	);

	expect(engine.runs).toEqual([]);
	expect(engine.sends).toEqual([]);
});

it('reopens the conversation run when the engine reports it failed', async () => {
	const { engine, instance, runtime, submissions } = createHarness({ runState: 'failed' });
	await seedQueuedSubmission(submissions, 'sub-1');

	await runtime.onStart(instance, () => {});

	expect(engine.reopened).toEqual([CONVERSATION_RUN_ID]);
	expect(engine.mailbox).toHaveLength(1);
});

it('returns a replaying turn to idle when reconciliation throws', async () => {
	const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	// No registered agent, so `reconcileInterruptedSubmission` throws before
	// it can produce a replacement attempt.
	const { engine, instance, runtime, submissions } = createHarness({ agents: [] });
	await seedQueuedSubmission(submissions, 'sub-1');
	const claimed = await submissions.claimSubmission({
		submissionId: 'sub-1',
		attemptId: 'attempt-1',
		ownerId: 'durable-object-id',
		leaseExpiresAt: 0,
	});
	expect(claimed?.attemptId).toBe('attempt-1');

	// The claim was not made by this isolate's idle pass, so the turn takes
	// the replay branch.
	const next = await runtime
		.conversationDefinition(instance)
		.phases.turn({ phase: 'turn', submissionId: 'sub-1', attemptId: 'attempt-1' }, engine.ctx);

	expect(next).toEqual({ phase: 'idle', deferrals: 0 });
	expect((await submissions.getSubmission('sub-1'))?.status).toBe('running');
	expect(
		logged.mock.calls.some(
			([tag, , error]) =>
				tag === '[flue:submission-reconciliation]' &&
				error instanceof Error &&
				error.message.includes('Agent target unavailable'),
		),
	).toBe(true);
});

it('refuses an "agents" package without the state-machine engine', async () => {
	const { instance, runtime, submissions } = createHarness({
		tasks: { run: async () => ({ accepted: true, state: 'running' }) },
	});
	await seedQueuedSubmission(submissions, 'sub-1');

	await expect(runtime.onStart(instance, () => {})).rejects.toThrow(
		'does not provide the Cloudflare Agents SDK state-machine engine',
	);
});
