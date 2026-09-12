import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCallHandle } from '../abort.ts';
import type { AgentSubmission } from '../agent-execution-store.ts';
import { createFlueContext } from '../client.ts';
import { createCloudflareAgentRuntime } from '../cloudflare/agent-coordinator.ts';
import type { Harness } from '../harness.ts';
import { observe } from '../index.ts';
import { createNodeAgentCoordinator } from '../node/agent-coordinator.ts';
import { sqlite } from '../node/agent-execution-store.ts';
import type { FlueObservation } from '../types.ts';
import type { AgentSubmissionInput, AgentSubmissionSession } from './agent-submissions.ts';
import { drainGlobalEventDeliveries } from './events.ts';
import { generateAttemptId, generateSubmissionId } from './ids.ts';

type Platform = 'cloudflare' | 'node';
type AttemptEvent = Extract<FlueObservation, { type: 'submission_attempt_changed' }>;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	await drainGlobalEventDeliveries();
	vi.restoreAllMocks();
});

async function setup(platform: Platform, kind: 'direct' | 'dispatch' = 'direct') {
	const persistence = sqlite();
	await persistence.migrate?.();
	const stores = await persistence.connect();
	cleanups.push(() => persistence.close?.());
	const store = stores.submissionStore;
	const input: AgentSubmissionInput = {
		kind,
		submissionId: generateSubmissionId(),
		agent: 'AttemptAgent',
		id: 'attempt-events',
		message: { kind: 'user', body: 'Test input' },
		acceptedAt: new Date().toISOString(),
	};
	if (kind === 'direct') await store.admitDirect(input);
	else await store.admitDispatch(input);
	await store.markSubmissionCanonicalReady(input.submissionId);
	const order: string[] = [];
	const changes: AttemptEvent[] = [];
	const scopes: Array<{ id: string; req: Request | undefined }> = [];
	cleanups.push(
		observe((event, ctx) => {
			if (event.type !== 'submission_attempt_changed') return;
			order.push('event');
			changes.push(event);
			scopes.push({ id: ctx.id, req: ctx.req });
		}),
	);
	const returned: AgentSubmission[] = [];
	const getSubmission = store.getSubmission.bind(store);
	vi.spyOn(store, 'getSubmission').mockImplementation((...args) => {
		order.push('submission_read');
		return getSubmission(...args);
	});
	const claim = store.claimSubmission.bind(store);
	const replace = store.replaceSubmissionAttempt.bind(store);
	vi.spyOn(store, 'claimSubmission').mockImplementation(async (...args) => {
		const row = await claim(...args);
		if (row) {
			returned.push(row);
			order.push('claim_return');
		}
		return row;
	});
	vi.spyOn(store, 'replaceSubmissionAttempt').mockImplementation(async (...args) => {
		const row = await replace(...args);
		if (row) {
			returned.push(row);
			order.push('replace_return');
		}
		return row;
	});
	// Keep the coordinators, SQL guards, and observe() real. The session
	// driver completes locally, without a model or a provider request.
	const session: AgentSubmissionSession = {
		conversationId: 'test-conversation',
		inspectSubmissionInput: vi.fn(() => ({
			state: 'interrupted' as const,
			position: { lastStreamOffset: '41', pendingToolCount: null },
		})),
		processSubmissionInput: () =>
			createCallHandle(undefined, async () => {
				order.push('process');
			}),
		recordSubmissionTerminal: async () => [],
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
		ctx.initializeRootHarness = async () =>
			({ session: async () => session }) as unknown as Harness;
		return ctx;
	};
	const agents = [{ name: input.agent, agent: () => 'Test agent' }];
	let wake: () => Promise<void>;
	let idle: () => Promise<void>;
	if (platform === 'cloudflare') {
		const fibers: Promise<void>[] = [];
		const deliveries: Promise<unknown>[] = [];
		const runtime = createCloudflareAgentRuntime({
			agents,
			createContext,
			runWithInstanceContext: (_instance, _agentName, callback) => callback(),
		});
		const instance = {
			name: input.id,
			env: {},
			ctx: {
				id: { toString: () => 'test-object' },
				storage: {},
				waitUntil: (promise: Promise<unknown>) => deliveries.push(promise),
			},
			schedule: async () => undefined,
			runFiber: (
				_name: string,
				callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
			) => {
				order.push('fiber');
				const fiber = callback({ stash: () => {} });
				fibers.push(fiber);
				return fiber;
			},
		};
		runtime.attach(instance, { agentName: input.agent, ...stores });
		wake = () => runtime.drainSubmissions(instance);
		idle = async () => {
			await Promise.all(fibers);
			await Promise.all(deliveries);
		};
		cleanups.push(idle);
	} else {
		const coordinator = createNodeAgentCoordinator({
			submissions: store,
			agents,
			createContext,
		});
		wake = () => coordinator.reconcileSubmissions();
		idle = () => coordinator.waitForIdle();
		cleanups.push(() => coordinator.shutdown());
	}
	const startInterrupted = async () => {
		const row = await claim({
			submissionId: input.submissionId,
			attemptId: generateAttemptId(),
			ownerId: 'previous-process',
			leaseExpiresAt: Date.now() - 60_000,
		});
		expect(row?.attemptId).toBeDefined();
		if (!row?.attemptId) throw new Error('Test claim did not return an attempt');
		return { ...row, attemptId: row.attemptId };
	};
	return {
		store,
		input,
		order,
		changes,
		scopes,
		returned,
		session,
		claim,
		replace,
		wake,
		idle,
		startInterrupted,
	};
}

describe.each<Platform>(['cloudflare', 'node'])('%s committed attempt events', (platform) => {
	it.each(['direct', 'dispatch'] as const)(
		'reports a returned %s claim before execution',
		async (kind) => {
			const test = await setup(platform, kind);
			await Promise.all([test.wake(), test.wake()]);
			await test.idle();
			expect(test.changes).toHaveLength(1);
			expect(test.scopes).toEqual([{ id: test.input.id, req: undefined }]);
			const row = test.returned[0];
			expect(row).toBeDefined();
			expect(test.changes[0]).toEqual({
				type: 'submission_attempt_changed',
				submissionId: row?.submissionId,
				kind,
				operation: 'claim_submission',
				previous: { attemptId: null, attemptCount: 0 },
				current: { attemptId: row?.attemptId, attemptCount: row?.attemptCount },
				maxAttempts: row?.maxAttempts,
				reason: 'queued_claim',
				position: { lastStreamOffset: null, pendingToolCount: null },
				v: 3,
				eventIndex: expect.any(Number),
				timestamp: expect.any(String),
				agentName: test.input.agent,
				instanceId: test.input.id,
			});
			expect(test.order.slice(0, 3)).toEqual([
				'claim_return',
				'event',
				platform === 'cloudflare' ? 'fiber' : 'submission_read',
			]);
			expect(test.order).toContain('process');
			expect((await test.store.getSubmission(test.input.submissionId))?.status).toBe('settled');
		},
	);

	it('keeps the observed count after requeue without inventing a prior ID', async () => {
		const test = await setup(platform);
		for (let count = 0; count < 3; count++) {
			const old = await test.startInterrupted();
			await test.store.markSubmissionInputApplied(old, {
				maxAttempts: 7,
				timeoutAt: Date.now() + 60_000,
			});
			await test.store.requeueSubmission(old);
		}
		await test.wake();
		await test.idle();
		expect(test.changes).toHaveLength(1);
		expect(test.changes[0]?.previous).toEqual({ attemptId: null, attemptCount: 3 });
		expect(test.changes[0]?.current.attemptCount).toBe(4);
		expect(test.changes[0]?.maxAttempts).toBe(10);
	});

	it('leaves a stale queued snapshot unknown after a competing claim and requeue', async () => {
		const test = await setup(platform);
		const list = test.store.listRunnableSubmissions.bind(test.store);
		vi.spyOn(test.store, 'listRunnableSubmissions').mockImplementationOnce(async () => {
			const selected = await list();
			await test.store.requeueSubmission(await test.startInterrupted());
			return selected;
		});
		await test.wake();
		await test.idle();
		expect(test.changes).toHaveLength(1);
		expect(test.changes[0]?.previous).toBeNull();
		expect(test.changes[0]?.current).toEqual({
			attemptId: test.returned[0]?.attemptId,
			attemptCount: 2,
		});
	});

	it('emits no change when a competing claim makes the selected row stale', async () => {
		const test = await setup(platform);
		const list = test.store.listRunnableSubmissions.bind(test.store);
		vi.spyOn(test.store, 'listRunnableSubmissions').mockImplementationOnce(async () => {
			const selected = await list();
			await test.claim({
				submissionId: test.input.submissionId,
				attemptId: generateAttemptId(),
				ownerId: 'competing-process',
				leaseExpiresAt: Date.now() + 60_000,
			});
			return selected;
		});
		await test.wake();
		await test.idle();
		expect(test.store.claimSubmission).toHaveBeenCalled();
		expect(test.returned).toEqual([]);
		expect(test.changes).toEqual([]);
		expect(test.order).not.toContain('process');
	});

	it('reports the guarded replacement once with its current and previous IDs', async () => {
		const test = await setup(platform);
		const old = await test.startInterrupted();
		await Promise.all([test.wake(), test.wake()]);
		await test.idle();
		expect(test.changes).toHaveLength(1);
		const row = test.returned[0];
		expect(row?.attemptId).not.toBe(old.attemptId);
		expect(test.changes[0]).toMatchObject({
			submissionId: old.submissionId,
			operation: 'replace_submission_attempt',
			previous: { attemptId: old.attemptId, attemptCount: old.attemptCount },
			current: { attemptId: row?.attemptId, attemptCount: row?.attemptCount },
			maxAttempts: row?.maxAttempts,
			reason: 'interrupted_transcript',
			position: { lastStreamOffset: '41', pendingToolCount: null },
		});
		const committed = test.order.indexOf('replace_return');
		expect(committed).toBeGreaterThanOrEqual(0);
		expect(test.order.slice(committed, committed + 3)).toEqual([
			'replace_return',
			'event',
			platform === 'cloudflare' ? 'fiber' : 'submission_read',
		]);
		expect(test.order.filter((step) => step === 'process')).toHaveLength(1);
	});

	it('emits no change for a replacement rejected by the attempt guard', async () => {
		const test = await setup(platform);
		await test.startInterrupted();
		const method = platform === 'cloudflare' ? 'listRunningSubmissions' : 'listExpiredSubmissions';
		const list = test.store[method].bind(test.store);
		vi.spyOn(test.store, method).mockImplementationOnce(async () => {
			const selected = await list();
			const old = selected[0];
			if (!old?.attemptId) throw new Error('Test recovery found no running attempt');
			await test.replace(
				{ submissionId: old.submissionId, attemptId: old.attemptId },
				generateAttemptId(),
				{
					ownerId: 'competing-process',
					leaseExpiresAt: Date.now() + 60_000,
				},
			);
			return selected;
		});
		await test.wake();
		await test.idle();
		expect(test.store.replaceSubmissionAttempt).toHaveBeenCalled();
		expect(test.returned).toEqual([]);
		expect(test.changes).toEqual([]);
		expect(test.order).not.toContain('process');
	});

	it.each(['claim', 'replacement'])(
		'contains thrown and rejected observers during a %s',
		async (operation) => {
			const failure = new Error('Test observer failure');
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
			cleanups.push(
				observe((event) => {
					if (event.type === 'submission_attempt_changed') throw failure;
				}),
			);
			cleanups.push(
				observe(async (event) => {
					if (event.type === 'submission_attempt_changed') throw failure;
				}),
			);
			const test = await setup(platform);
			if (operation === 'replacement') await test.startInterrupted();
			await test.wake();
			await test.idle();
			await drainGlobalEventDeliveries();
			expect(test.changes).toHaveLength(1);
			expect(test.order).toContain('process');
			expect((await test.store.getSubmission(test.input.submissionId))?.status).toBe('settled');
			expect(logged.mock.calls.filter(([, error]) => error === failure)).toHaveLength(2);
		},
	);
});
