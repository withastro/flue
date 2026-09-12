import { afterEach, describe, expect, it } from 'vitest';
import { createCallHandle } from '../abort.ts';
import type { AgentSubmission, AgentSubmissionStore } from '../agent-execution-store.ts';
import { createFlueContext } from '../client.ts';
import { createCloudflareAgentRuntime } from '../cloudflare/agent-coordinator.ts';
import type { Harness } from '../harness.ts';
import { observe } from '../index.ts';
import { createNodeAgentCoordinator } from '../node/agent-coordinator.ts';
import { sqlite } from '../node/agent-execution-store.ts';
import type { FlueObservation } from '../types.ts';
import {
	type AgentSubmissionInput,
	type AgentSubmissionInspection,
	type AgentSubmissionSession,
	emitSubmissionRecoveryDecision,
} from './agent-submissions.ts';
import { createCoordinatorEventEmitter, drainGlobalEventDeliveries } from './events.ts';
import { generateAttemptId, generateSubmissionId } from './ids.ts';

type Platform = 'cloudflare' | 'node';
type Decision = Extract<FlueObservation, { type: 'submission_recovery_decision' }>;
const cleanups: Array<() => void | Promise<void>> = [];
const position = { lastStreamOffset: '41', pendingToolCount: null };

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	await drainGlobalEventDeliveries();
});

async function setup(
	platform: Platform,
	options: {
		state?: AgentSubmissionInspection;
		kind?: 'direct' | 'dispatch';
		count?: number;
		timedOut?: boolean;
		aborted?: boolean;
		inspect?: () => void | Promise<void>;
		terminal?: () => void | Promise<void>;
		beforeStoreCall?: (method: PropertyKey) => void;
		afterRunningList?: (rows: AgentSubmission[]) => Promise<void>;
	} = {},
) {
	const persistence = sqlite();
	await persistence.migrate?.();
	const stores = await persistence.connect();
	cleanups.push(() => persistence.close?.());
	const sqlStore = stores.submissionStore;
	const input: AgentSubmissionInput = {
		kind: options.kind ?? 'direct',
		submissionId: generateSubmissionId(),
		agent: 'RecoveryAgent',
		id: 'recovery-events',
		message: { kind: 'user', body: 'Local test input' },
		acceptedAt: new Date().toISOString(),
	};
	if (input.kind === 'direct') await sqlStore.admitDirect(input);
	else await sqlStore.admitDispatch(input);
	await sqlStore.markSubmissionCanonicalReady(input.submissionId);
	let claimed = await sqlStore.claimSubmission({
		submissionId: input.submissionId,
		attemptId: generateAttemptId(),
		ownerId: 'old-process',
		leaseExpiresAt: Date.now() - 60_000,
	});
	for (let count = 1; count < (options.count ?? 10); count++) {
		if (!claimed?.attemptId) throw new Error('Missing test attempt');
		await sqlStore.requeueSubmission({
			submissionId: input.submissionId,
			attemptId: claimed.attemptId,
		});
		claimed = await sqlStore.claimSubmission({
			submissionId: input.submissionId,
			attemptId: generateAttemptId(),
			ownerId: 'old-process',
			leaseExpiresAt: Date.now() - 60_000,
		});
	}
	if (!claimed?.attemptId) throw new Error('Missing test claim');
	const attempt = { submissionId: input.submissionId, attemptId: claimed.attemptId };
	if (options.timedOut) {
		await sqlStore.markSubmissionInputApplied(attempt, {
			maxAttempts: 10,
			timeoutAt: Date.now() - 1,
		});
	}
	if (options.aborted) await sqlStore.requestSessionAbort(claimed.sessionKey);
	const row = await sqlStore.getSubmission(input.submissionId);
	if (!row) throw new Error('Missing test row');

	// Inject a recording adapter. All normal operations still use the real SQL store.
	const calls: string[] = [];
	const store: AgentSubmissionStore = new Proxy(sqlStore, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== 'function') return value;
			return async (...args: unknown[]) => {
				calls.push(String(key));
				options.beforeStoreCall?.(key);
				if (key === 'listRunningSubmissions' || key === 'listExpiredSubmissions') {
					const result = await target[key]();
					await options.afterRunningList?.(result);
					return result;
				}
				return Reflect.apply(value, target, args);
			};
		},
	});
	const order: string[] = [];
	const events: FlueObservation[] = [];
	const unsubscribe = observe((event) => {
		events.push(event);
		if (event.type === 'submission_recovery_decision') order.push(event.reason);
	});
	cleanups.push(unsubscribe);
	const session: AgentSubmissionSession = {
		conversationId: 'test-conversation',
		inspectSubmissionInput: async () => {
			order.push('inspect');
			await options.inspect?.();
			return { state: options.state ?? 'interrupted', position };
		},
		processSubmissionInput: () =>
			createCallHandle(undefined, async () => {
				order.push('process');
			}),
		recordSubmissionTerminal: async () => {
			order.push('terminal');
			await options.terminal?.();
			return [];
		},
	};
	const createContext = () => {
		order.push('context');
		const ctx = createFlueContext({
			id: input.id,
			agentName: input.agent,
			submissionId: input.submissionId,
			env: {},
			agentConfig: { resolveModel: () => undefined },
		});
		// SAFETY: openAgentSubmissionSession explicitly supports this local driver.
		ctx.initializeRootHarness = async () =>
			({ session: async () => session }) as unknown as Harness;
		return ctx;
	};
	const agents = [{ name: input.agent, agent: () => 'Local recovery test' }];
	let wake: () => Promise<void>;
	let idle: () => Promise<void>;
	if (platform === 'cloudflare') {
		const fibers: Promise<unknown>[] = [];
		const runtime = createCloudflareAgentRuntime({
			agents,
			createContext,
			runWithInstanceContext: (_instance, _name, callback) => callback(),
		});
		const instance = {
			name: input.id,
			env: {},
			ctx: {
				id: { toString: () => 'test-object' },
				storage: {},
				waitUntil: (p: Promise<unknown>) => fibers.push(p),
			},
			schedule: async () => undefined,
			runFiber: (
				_name: string,
				callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
			) => {
				const fiber = callback({ stash: () => {} });
				fibers.push(fiber);
				return fiber;
			},
		};
		runtime.attach(instance, { agentName: input.agent, ...stores, submissionStore: store });
		wake = () => runtime.drainSubmissions(instance);
		idle = async () => {
			await Promise.all(fibers);
		};
		cleanups.push(idle);
	} else {
		const coordinator = createNodeAgentCoordinator({ submissions: store, agents, createContext });
		wake = () => coordinator.reconcileSubmissions();
		idle = () => coordinator.waitForIdle();
		cleanups.push(() => coordinator.shutdown());
	}
	return {
		wake,
		idle,
		sqlStore,
		input,
		row,
		order,
		events,
		calls,
		decisions: () =>
			events.filter((event): event is Decision => event.type === 'submission_recovery_decision'),
	};
}

describe.each<Platform>(['cloudflare', 'node'])('%s recovery decisions', (platform) => {
	it.each(['absent', 'interrupted'] as const)(
		'reports %s at the limit before terminal work',
		async (state) => {
			const test = await setup(platform, { state });
			await test.wake();
			await test.idle();
			expect(test.decisions()).toHaveLength(1);
			expect(test.decisions()[0]).toEqual({
				type: 'submission_recovery_decision',
				submissionId: test.input.submissionId,
				kind: 'direct',
				attempt: { attemptId: test.row.attemptId, attemptCount: 10 },
				maxAttempts: 10,
				operation: 'reconcile_submission',
				reason: 'retry_exhausted',
				position,
				error: null,
				v: 3,
				eventIndex: expect.any(Number),
				timestamp: expect.any(String),
				agentName: test.input.agent,
				instanceId: test.input.id,
			});
			expect(test.order).toEqual(['context', 'inspect', 'retry_exhausted', 'context', 'terminal']);
			const settled = await test.sqlStore.getSubmission(test.input.submissionId);
			expect(settled?.status).toBe('settled');
			expect(settled?.attemptCount).toBe(10);
			expect(settled?.error).toContain(state === 'absent' ? 'before input' : 'recovery attempts');
		},
	);

	it('keeps completed-at-limit ahead of abort, budget, and timeout', async () => {
		const test = await setup(platform, { state: 'completed', aborted: true, timedOut: true });
		await test.wake();
		await test.idle();
		expect(test.decisions()).toEqual([]);
		expect(test.order).toEqual(['context', 'inspect']);
		expect(test.events).toContainEqual(
			expect.objectContaining({ type: 'submission_settled', outcome: 'completed' }),
		);
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.error).toBeUndefined();
	});

	it('keeps abort ahead of budget and timeout', async () => {
		const test = await setup(platform, { aborted: true, timedOut: true });
		await test.wake();
		await test.idle();
		expect(test.decisions()).toEqual([]);
		expect(test.events).toContainEqual(
			expect.objectContaining({ type: 'submission_settled', outcome: 'aborted' }),
		);
	});

	it.each([1, 10])('selects the existing budget/timeout order at count %s', async (count) => {
		const test = await setup(platform, { kind: 'dispatch', count, timedOut: true });
		await test.wake();
		await test.idle();
		expect(test.decisions()).toHaveLength(1);
		expect(test.decisions()[0]).toMatchObject({
			kind: 'dispatch',
			reason: count === 10 ? 'retry_exhausted' : 'timeout',
			error: null,
		});
		expect(test.order.slice(2)).toEqual([
			count === 10 ? 'retry_exhausted' : 'timeout',
			'context',
			'terminal',
		]);
	});

	it('reports the caught terminal write separately and still settles', async () => {
		const test = await setup(platform, {
			terminal: () => {
				throw new Error('Local terminal failure');
			},
		});
		await test.wake();
		await test.idle();
		expect(test.decisions().map((event) => event.reason)).toEqual([
			'retry_exhausted',
			'reconcile_failed',
		]);
		expect(test.decisions()[1]).toMatchObject({
			position,
			error: { name: 'Error', retryable: null, overloaded: null, remote: null },
		});
		expect(test.order.slice(2)).toEqual([
			'retry_exhausted',
			'context',
			'terminal',
			'reconcile_failed',
		]);
		expect(test.events).toContainEqual(
			expect.objectContaining({ type: 'submission_recovery', outcome: 'terminated' }),
		);
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.status).toBe('settled');
	});

	it('leaves the position unknown when inspection fails', async () => {
		const error = Object.assign(new Error('Local inspection failure'), {
			retryable: false,
			remote: true,
		});
		const test = await setup(platform, {
			inspect: () => {
				throw error;
			},
		});
		await test.wake();
		await test.idle();
		expect(test.decisions()).toHaveLength(1);
		expect(test.decisions()[0]).toMatchObject({
			submissionId: test.input.submissionId,
			attempt: { attemptId: test.row.attemptId, attemptCount: 10 },
			reason: 'reconcile_failed',
			position: { lastStreamOffset: null, pendingToolCount: null },
			error: { name: 'Error', retryable: false, overloaded: null, remote: true },
		});
		expect(
			test.events.findIndex((event) => event.type === 'submission_recovery_decision'),
		).toBeLessThan(test.events.findIndex((event) => event.type === 'submission_recovery'));
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.status).toBe('running');
	});

	it('keeps a selected failure distinct from failed settlement', async () => {
		const test = await setup(platform, {
			beforeStoreCall: (method) => {
				if (method === 'failSubmission') throw new Error('Local settlement failure');
			},
		});
		await test.wake();
		await test.idle();
		expect(test.decisions().map((event) => event.reason)).toEqual([
			'retry_exhausted',
			'reconcile_failed',
		]);
		expect(test.events.some((event) => event.type === 'submission_settled')).toBe(false);
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.status).toBe('running');
	});

	it('omits submission fields for a pass failure without a row', async () => {
		let failures = 0;
		const test = await setup(platform, {
			beforeStoreCall: (method) => {
				if (method === 'listRunnableSubmissions' && failures++ === 0)
					throw new Error('Local list failure');
			},
		});
		await test.wake();
		await test.idle();
		const pass = test.decisions().filter((event) => event.operation === 'reconcile_pass');
		expect(pass).toHaveLength(1);
		expect(pass[0]).toMatchObject({
			reason: 'reconcile_failed',
			kind: null,
			attempt: null,
			maxAttempts: null,
			position: { lastStreamOffset: null, pendingToolCount: null },
		});
		expect(pass[0]).not.toHaveProperty('submissionId');
	});

	it('emits no decision or attempt change after a rejected stale replacement', async () => {
		let raced = false;
		const test = await setup(platform, {
			count: 1,
			afterRunningList: async (rows) => {
				if (raced) return;
				raced = true;
				const row = rows[0];
				if (!row?.attemptId) throw new Error('Missing stale test row');
				await test.sqlStore.replaceSubmissionAttempt(
					{ submissionId: row.submissionId, attemptId: row.attemptId },
					generateAttemptId(),
					{ ownerId: 'competitor', leaseExpiresAt: Date.now() + 60_000 },
				);
			},
		});
		await test.wake();
		await test.idle();
		expect(test.calls).toContain('replaceSubmissionAttempt');
		expect(test.decisions()).toEqual([]);
		expect(test.events.filter((event) => event.type === 'submission_attempt_changed')).toEqual([]);
		expect(test.order).not.toContain('process');
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.attemptCount).toBe(2);
	});

	it('contains thrown and rejected decision subscribers', async () => {
		let thrown = 0;
		let rejected = 0;
		cleanups.push(
			observe((event) => {
				if (event.type === 'submission_recovery_decision') {
					thrown++;
					throw new Error('Local subscriber throw');
				}
			}),
		);
		cleanups.push(
			observe(async (event) => {
				if (event.type === 'submission_recovery_decision') {
					rejected++;
					throw new Error('Local subscriber rejection');
				}
			}),
		);
		const test = await setup(platform);
		await test.wake();
		await test.idle();
		await drainGlobalEventDeliveries();
		expect(thrown).toBe(1);
		expect(rejected).toBe(1);
		expect(test.decisions()).toHaveLength(1);
		expect((await test.sqlStore.getSubmission(test.input.submissionId))?.status).toBe('settled');
	});
});

function summary(error: unknown): Decision['error'] {
	const decisions: Decision[] = [];
	const stop = observe((event) => {
		if (event.type === 'submission_recovery_decision') decisions.push(event);
	});
	try {
		emitSubmissionRecoveryDecision(createCoordinatorEventEmitter({ env: {} }), {
			operation: 'reconcile_pass',
			reason: 'reconcile_failed',
			error,
		});
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).not.toHaveProperty('errorInfo');
		return decisions[0]?.error ?? null;
	} finally {
		stop();
	}
}

describe('safe recovery causes', () => {
	it('copies the first Boolean platform entry without wrapper fields', () => {
		expect(
			summary({
				name: 'Wrapper',
				remote: 'true',
				message: 'private',
				cause: { name: 'RpcError', retryable: false, cause: { name: 'Deeper', overloaded: true } },
			}),
		).toEqual({ name: 'RpcError', retryable: false, overloaded: null, remote: null });
	});
	it('keeps the first safe name when no entry has a Boolean flag', () => {
		expect(summary({ name: 'Wrapper', retryable: 1, cause: new Error('private') })).toEqual({
			name: 'Wrapper',
			retryable: null,
			overloaded: null,
			remote: null,
		});
	});
	it.each(['', 'Error with body', 'Error\n', 'Error\r', 'E'.repeat(81), '1Error'])(
		'keeps invalid name %j unknown on a flagged entry',
		(name) => {
			expect(summary({ name: 'Wrapper', cause: { name, remote: true } })).toEqual({
				name: null,
				retryable: null,
				overloaded: null,
				remote: true,
			});
		},
	);
	it.each(['Rpc.Error-v2', '_Error', '$Error', 'E'.repeat(80)])('keeps valid name %j', (name) => {
		expect(summary({ name })).toEqual({ name, retryable: null, overloaded: null, remote: null });
	});
	it.each([undefined, null, 'private text', 7, { message: 'private', retryable: 'true' }])(
		'keeps unusable cause %j unknown',
		(error) => {
			expect(summary(error)).toBeNull();
		},
	);
	it('contains property failures and never reads raw error detail', () => {
		const unexpectedReads: string[] = [];
		const error = {
			get name() {
				throw new Error('Local getter');
			},
			get overloaded() {
				throw new Error('Local getter');
			},
			remote: false,
			get message() {
				unexpectedReads.push('message');
				throw new Error('Must not read message');
			},
			get stack() {
				unexpectedReads.push('stack');
				throw new Error('Must not read stack');
			},
			get cause() {
				unexpectedReads.push('cause');
				throw new Error('Must not read past selected entry');
			},
		};
		expect(summary(error)).toEqual({
			name: null,
			retryable: null,
			overloaded: null,
			remote: false,
		});
		expect(unexpectedReads).toEqual([]);
		expect(
			summary({
				name: 'Outer',
				get cause() {
					throw new Error('Local cause getter');
				},
			}),
		).toEqual({ name: 'Outer', retryable: null, overloaded: null, remote: null });
	});
	it('contains cycles and inspects no more than four entries', () => {
		const cycle: { name: string; cause?: unknown } = { name: 'Outer' };
		cycle.cause = cycle;
		expect(summary(cycle)?.name).toBe('Outer');
		let error: unknown = { name: 'Fifth', retryable: true };
		for (let i = 0; i < 4; i++) error = { cause: error };
		expect(summary(error)).toBeNull();
		expect(summary({ cause: { cause: { cause: { name: 'Fourth', remote: true } } } })?.name).toBe(
			'Fourth',
		);
	});
	it('contains a throwing emitter', () => {
		expect(() =>
			emitSubmissionRecoveryDecision(
				() => {
					throw new Error('Local emitter');
				},
				{ operation: 'reconcile_pass', reason: 'reconcile_failed' },
			),
		).not.toThrow();
	});
});
