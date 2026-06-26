/**
 * Shared contract tests for AgentExecutionStore implementations.
 *
 * Adapter packages call {@link defineStoreContractTests} with a factory
 * function that creates their backend. The tests exercise every method
 * on `AgentSubmissionStore` with identical behavioral
 * assertions regardless of the underlying storage engine.
 *
 * @example
 * ```ts
 * import { defineStoreContractTests } from '@flue/runtime/test-utils';
 *
 * defineStoreContractTests('My Backend', {
 *   async create() { return myStore; },
 *   async cleanup() { await myStore.close(); },
 * });
 * ```
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../agent-execution-store.ts';
import type { DirectAgentSubmissionInput } from '../runtime/agent-submissions.ts';
import type { DispatchInput } from '../runtime/dispatch-queue.ts';

export { defineAttachmentStoreContractTests } from './define-attachment-store-contract-tests.ts';
export { defineConversationStreamStoreContractTests } from './define-conversation-stream-store-contract-tests.ts';
export { defineEventStreamStoreContractTests } from './define-event-stream-store-contract-tests.ts';
export { defineRunStoreContractTests } from './define-run-store-contract-tests.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		input: { text: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function directInput(
	overrides: Partial<DirectAgentSubmissionInput> = {},
): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId } as const;
}

function claim(submissionId: string, attemptId: string, ownerId = 'test-owner') {
	return { submissionId, attemptId, ownerId, leaseExpiresAt: Date.now() + 30_000 };
}

async function admitDispatchReady(store: AgentExecutionStore, input: DispatchInput) {
	const admission = await store.submissions.admitDispatch(input);
	if (admission.kind !== 'submission') return admission;
	const submission = await store.submissions.markSubmissionCanonicalReady(
		admission.submission.submissionId,
	);
	return { kind: 'submission' as const, submission: submission ?? admission.submission };
}

async function admitDirectReady(store: AgentExecutionStore, input: DirectAgentSubmissionInput) {
	const submission = await store.submissions.admitDirect(input);
	return (await store.submissions.markSubmissionCanonicalReady(submission.submissionId)) ?? submission;
}

// ─── Contract test definition ───────────────────────────────────────────────

export interface StoreContractTestBackend {
	/** Create a fresh store instance for a single test. */
	create(): AgentExecutionStore | Promise<AgentExecutionStore>;
	/** Optional cleanup after each test (e.g. close connections, delete temp files). */
	cleanup?(): void | Promise<void>;
}

/**
 * Register the standard AgentExecutionStore contract tests under the given
 * describe label. Each test gets a fresh store from `backend.create()`.
 */
export function defineStoreContractTests(label: string, backend: StoreContractTestBackend): void {
	describe(label, () => {
		let _cleanup: (() => void | Promise<void>) | undefined;

		async function create(): Promise<AgentExecutionStore> {
			_cleanup = backend.cleanup;
			return backend.create();
		}

		afterEach(async () => {
			await _cleanup?.();
			_cleanup = undefined;
		});

		// ── Dispatch admission ────────────────────────────────────────────

		describe('dispatch admission', () => {
			it('admits one queued dispatch row when the same submission is replayed', async () => {
				const store = await create();
				const first = await store.submissions.admitDispatch(dispatchInput());
				const replay = await store.submissions.admitDispatch(dispatchInput());
				expect(replay).toEqual(first);
				expect(first).toMatchObject({
					kind: 'submission',
					submission: {
						submissionId: 'dispatch-1',
						sessionKey: 'agent-session:["agent-1","default","default"]',
						status: 'queued',
					},
				});
			});

			it('returns conflict when one dispatch id is reused with another payload', async () => {
				const store = await create();
				await store.submissions.admitDispatch(dispatchInput());
				expect(
					await store.submissions.admitDispatch(dispatchInput({ input: { text: 'Different' } })),
				).toEqual({
					kind: 'conflict',
				});
			});
		});

		// ── Direct admission ───────────────────────────────────────────────

		describe('direct admission', () => {
			it('round-trips direct submission images', async () => {
				const store = await create();
				const input = directInput({
					payload: {
						message: 'Hello',
						images: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }],
					},
				});
				const admitted = await admitDirectReady(store,input);
				expect(admitted.input).toEqual(input);
				expect((await store.submissions.getSubmission(input.submissionId))?.input).toEqual(input);
			});

			it('rejects replay when a direct submission image has different bytes', async () => {
				const store = await create();
				await admitDirectReady(store,
					directInput({
						payload: {
							message: 'Hello',
							images: [{ type: 'image', data: 'first-image', mimeType: 'image/png' }],
						},
					}),
				);
				await expect(
					admitDirectReady(store,
						directInput({
							payload: {
								message: 'Hello',
								images: [{ type: 'image', data: 'second-image', mimeType: 'image/png' }],
							},
						}),
					),
				).rejects.toThrow('unexpected result');
			});
		});

		describe('canonical readiness', () => {
			it('does not list or claim a queued submission before canonical readiness', async () => {
				const store = await create();
				const admission = await store.submissions.admitDispatch(dispatchInput());
				expect(admission).toMatchObject({
					kind: 'submission',
					submission: { canonicalReadyAt: null },
				});
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1')),
				).toBeNull();
			});

			it('lists unready queued submissions in admission order', async () => {
				const store = await create();
				const first = await store.submissions.admitDispatch(dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				const third = await store.submissions.admitDirect(
					directInput({ submissionId: 'direct-2', id: 'agent-2' }),
				);
				expect(await store.submissions.listUnreadySubmissions()).toEqual([
					expect.objectContaining({
						submissionId: first.kind === 'submission' ? first.submission.submissionId : '',
					}),
					expect.objectContaining({ submissionId: third.submissionId }),
				]);
			});

			it('lists and claims a queued submission after canonical readiness', async () => {
				const store = await create();
				await store.submissions.admitDispatch(dispatchInput());
				const ready = await store.submissions.markSubmissionCanonicalReady('dispatch-1');
				expect(ready?.canonicalReadyAt).toEqual(expect.any(Number));
				expect(await store.submissions.markSubmissionCanonicalReady('dispatch-1')).toEqual(ready);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([ready]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1')),
				).toMatchObject({ status: 'running', canonicalReadyAt: ready?.canonicalReadyAt });
			});
		});

		// ── Submission ordering ───────────────────────────────────────────

		describe('submission ordering', () => {
			it('orders direct and dispatched submissions together within one session', async () => {
				const store = await create();
				const direct = await admitDirectReady(store,directInput());
				await admitDispatchReady(store,dispatchInput());
				const other = await admitDirectReady(store,
					directInput({ submissionId: 'direct-2', id: 'agent-2' }),
				);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([direct, other]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-blocked')),
				).toBeNull();
			});

			it('lists queued dispatches in admission order and selects one runnable head per session', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'dispatch-3', id: 'agent-2' }),
				);

				expect(await store.submissions.listRunnableSubmissions()).toEqual([
					expect.objectContaining({ submissionId: 'dispatch-1' }),
					expect.objectContaining({ submissionId: 'dispatch-3' }),
				]);
			});
		});

		// ── Claim semantics ──────────────────────────────────────────────

		describe('claim semantics', () => {
			it('claims only runnable session heads while allowing separate sessions to claim independently', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'dispatch-3', id: 'agent-2' }),
				);

				const first = await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const blocked = await store.submissions.claimSubmission(claim('dispatch-2', 'attempt-2'));
				const other = await store.submissions.claimSubmission(claim('dispatch-3', 'attempt-3'));

				expect(first).toMatchObject({
					submissionId: 'dispatch-1',
					status: 'running',
					attemptId: 'attempt-1',
					startedAt: expect.any(Number),
				});
				expect(blocked).toBeNull();
				expect(other).toMatchObject({
					submissionId: 'dispatch-3',
					status: 'running',
					attemptId: 'attempt-3',
				});
				expect(await store.submissions.listRunningSubmissions()).toEqual([first, other]);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
			});
		});

		// ── Lifecycle transitions ─────────────────────────────────────────

		describe('lifecycle transitions', () => {
			it('records input application and recovery requests only for the owning attempt', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				expect(
					await store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
				expect(
					await store.submissions.markSubmissionInputApplied(
						attempt('dispatch-1', 'stale-attempt'),
					),
				).toBe(false);
				expect(
					await store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
				expect(
					await store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'stale-attempt')),
				).toBe(false);

				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'running',
					attemptId: 'attempt-1',
					inputAppliedAt: expect.any(Number),
					recoveryRequestedAt: expect.any(Number),
				});
			});

			it('requeues interrupted attempts only before canonical input application', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'requeue-safe' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'requeue-unsafe', id: 'agent-2' }),
				);
				await store.submissions.claimSubmission(claim('requeue-safe', 'attempt-safe'));
				await store.submissions.claimSubmission(claim('requeue-unsafe', 'attempt-unsafe'));
				await store.submissions.markSubmissionInputApplied(
					attempt('requeue-unsafe', 'attempt-unsafe'),
				);

				expect(
					await store.submissions.requeueSubmissionBeforeInputApplied(
						attempt('requeue-safe', 'attempt-safe'),
					),
				).toBe(true);
				expect(
					await store.submissions.requeueSubmissionBeforeInputApplied(
						attempt('requeue-unsafe', 'attempt-unsafe'),
					),
				).toBe(false);
				expect(await store.submissions.getSubmission('requeue-safe')).toMatchObject({
					status: 'queued',
				});
				expect(await store.submissions.getSubmission('requeue-unsafe')).toMatchObject({
					status: 'running',
				});
			});

			it('reports unsettled visibility until a claimed dispatch completes', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(true);
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listRunningSubmissions()).toHaveLength(1);
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'settled',
				});
			});

			it('ignores stale-attempt settlement and keeps the first owning terminal state', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				await store.submissions.completeSubmission(attempt('dispatch-1', 'stale-attempt'));
				await store.submissions.failSubmission(
					attempt('dispatch-1', 'attempt-1'),
					new Error('first failure'),
				);
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				await store.submissions.failSubmission(
					attempt('dispatch-1', 'attempt-1'),
					new Error('later failure'),
				);

				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'settled',
					error: 'first failure',
				});
			});
		});

		describe('direct settlement obligation', () => {
			const settlementRecord = (outcome: 'completed' | 'failed') => ({
				v: 1 as const,
				id: 'direct-1:settled',
				type: 'submission_settled' as const,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-06-22T00:00:00.000Z',
				submissionId: 'direct-1',
				attemptId: 'attempt-1',
				outcome,
			});

			it('reserves a canonical settlement only for the owning direct attempt', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const record = settlementRecord('completed');

				expect(
					await store.submissions.reserveSubmissionSettlement(attempt('direct-1', 'stale'), {
						recordId: record.id,
						record,
					}),
				).toBeNull();
				const reserved = await store.submissions.reserveSubmissionSettlement(
					attempt('direct-1', 'attempt-1'),
					{ recordId: record.id, record },
				);
				expect(reserved).toEqual({
					submissionId: 'direct-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					attemptId: 'attempt-1',
					recordId: record.id,
					record,
				});
				expect(await store.submissions.getSubmission('direct-1')).toMatchObject({
					status: 'terminalizing',
				});
			});

			it('replays an exact obligation and rejects a conflicting settlement payload', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const ref = attempt('direct-1', 'attempt-1');
				const completed = settlementRecord('completed');
				const first = await store.submissions.reserveSubmissionSettlement(ref, {
					recordId: completed.id,
					record: completed,
				});
				expect(
					await store.submissions.reserveSubmissionSettlement(ref, {
						recordId: completed.id,
						record: completed,
					}),
				).toEqual(first);
				expect(
					await store.submissions.reserveSubmissionSettlement(ref, {
						recordId: completed.id,
						record: settlementRecord('failed'),
					}),
				).toBeNull();
			});

			it('keeps terminalizing work unsettled and ordered but not runnable or reclaimable', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await admitDirectReady(store,directInput({ submissionId: 'direct-2' }));
				await store.submissions.claimSubmission({
					...claim('direct-1', 'attempt-1'),
					leaseExpiresAt: 1,
				});
				const record = settlementRecord('completed');
				await store.submissions.reserveSubmissionSettlement(attempt('direct-1', 'attempt-1'), {
					recordId: record.id,
					record,
				});

				expect(await store.submissions.hasUnsettledSubmissions()).toBe(true);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
				expect(await store.submissions.listRunningSubmissions()).toEqual([]);
				expect(await store.submissions.listExpiredSubmissions()).toEqual([]);
			});

			it('lists and finalizes a pending settlement obligation', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const ref = attempt('direct-1', 'attempt-1');
				const record = settlementRecord('completed');
				await store.submissions.reserveSubmissionSettlement(ref, {
					recordId: record.id,
					record,
				});
				expect(await store.submissions.listPendingSubmissionSettlements()).toEqual([
					{
						submissionId: 'direct-1',
						sessionKey: 'agent-session:["agent-1","default","default"]',
						attemptId: 'attempt-1',
						recordId: record.id,
						record,
					},
				]);
				expect(await store.submissions.finalizeSubmissionSettlement(ref, record.id)).toBe(true);
				expect(await store.submissions.listPendingSubmissionSettlements()).toEqual([]);
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
			});

			it('leaves dispatch settlement behavior unchanged', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const record = settlementRecord('completed');
				expect(
					await store.submissions.reserveSubmissionSettlement(attempt('dispatch-1', 'attempt-1'), {
						recordId: record.id,
						record,
					}),
				).toBeNull();
				expect(
					await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
			});
		});

		// ── Durability ───────────────────────────────────────────────────

		describe('durability', () => {
			it('initializes attempt_count to 0 and timeout_at to 0 at admission', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const submission = await store.submissions.getSubmission('dispatch-1');
				expect(submission).toMatchObject({
					attemptCount: 0,
					maxRetry: 10,
					timeoutAt: 0,
				});
			});

			it('sets attempt_count to 1 and applies system defaults at claim time', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const before = Date.now();
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const claimed = await store.submissions.getSubmission('dispatch-1');
				if (!claimed) throw new Error('Expected claimed submission to exist.');
				expect(claimed.attemptCount).toBe(1);
				expect(claimed.maxRetry).toBe(10);
				expect(claimed.timeoutAt).toBeGreaterThanOrEqual(before + 60 * 60_000);
			});

			it('applies custom durability when input is marked applied', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const customTimeout = Date.now() + 6 * 60 * 60_000;
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1'), {
					maxRetry: 5,
					timeoutAt: customTimeout,
				});
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 1,
					maxRetry: 5,
					timeoutAt: customTimeout,
				});
			});

			it('increments attempt_count on recovery via replaceTurnJournalAttempt', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 1,
				});

				await store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-1',
					turnId: 'turn-1',
					phase: 'before_provider',
				});

				const replaced = await store.submissions.replaceTurnJournalAttempt(
					attempt('dispatch-1', 'attempt-1'),
					'attempt-2',
				);
				expect(replaced).toMatchObject({ attemptCount: 2, attemptId: 'attempt-2' });
			});

			it('increments attempt_count and preserves timeout_at when reclaiming after requeue', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const first = await store.submissions.getSubmission('dispatch-1');
				if (!first) throw new Error('Expected claimed submission to exist.');
				expect(first.attemptCount).toBe(1);

				await store.submissions.requeueSubmissionBeforeInputApplied(
					attempt('dispatch-1', 'attempt-1'),
				);
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-2'));
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 2,
					timeoutAt: first.timeoutAt,
				});
			});
		});

		// ── Turn journal lifecycle ────────────────────────────────────────

		describe('turn journal lifecycle', () => {
			it('creates, advances, and commits a turn journal through all phases', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				expect(
					await store.submissions.beginTurnJournal({
						submissionId: 'dispatch-1',
						sessionKey: 'agent-session:["agent-1","default","default"]',
						kind: 'dispatch',
						attemptId: 'attempt-1',
						operationId: 'op-1',
						turnId: 'turn-1',
						phase: 'before_provider',
					}),
				).toBe(true);
				expect(
					await store.submissions.updateTurnJournalPhase(
						attempt('dispatch-1', 'attempt-1'),
						'provider_started',
					),
				).toBe(true);
				expect(
					await store.submissions.updateTurnJournalPhase(
						attempt('dispatch-1', 'attempt-1'),
						'tool_request_recorded',
						{
							toolRequest: { toolCalls: ['lookup'] },
						},
					),
				).toBe(true);
				expect(await store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
					phase: 'tool_request_recorded',
					committed: false,
					toolRequest: { toolCalls: ['lookup'] },
				});
				expect(
					await store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1'),
				).toBe(true);
				expect(await store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
					phase: 'committed',
					committed: true,
					committedLeafId: 'leaf-1',
				});
			});

			it('returns false when a committed turn journal is committed again', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-1',
					turnId: 'turn-1',
					phase: 'before_provider',
				});
				await store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1');
				expect(
					await store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1'),
				).toBe(false);
			});

			it('resets journal on new turn after commit', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-1',
					turnId: 'turn-1',
					phase: 'before_provider',
				});
				await store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1');

				await store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-2',
					turnId: 'turn-2',
					phase: 'before_provider',
				});

				expect(await store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
					phase: 'before_provider',
					committed: false,
					operationId: 'op-2',
					turnId: 'turn-2',
				});
			});

			it('replaces the journal attempt and returns the updated submission', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-1',
					turnId: 'turn-1',
					phase: 'before_provider',
				});

				const replaced = await store.submissions.replaceTurnJournalAttempt(
					attempt('dispatch-1', 'attempt-1'),
					'attempt-2',
				);

				expect(replaced).toMatchObject({
					submissionId: 'dispatch-1',
					status: 'running',
					attemptId: 'attempt-2',
				});
				expect(await store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
					attemptId: 'attempt-2',
				});
			});
		});

		// ── Attempt markers ──────────────────────────────────────────────

		describe('attempt markers', () => {
			it('lists inserted markers with creation timestamps', async () => {
				const store = await create();
				const before = Date.now();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				const markers = await store.submissions.listAttemptMarkers();
				expect(markers).toEqual([
					{ submissionId: 'dispatch-1', attemptId: 'attempt-1', createdAt: expect.any(Number) },
				]);
				const [marker] = markers;
				expect(marker).toBeDefined();
				if (!marker) throw new Error('Expected an attempt marker.');
				expect(marker.createdAt).toBeGreaterThanOrEqual(before);
			});

			it('keeps one marker with the original timestamp when the same attempt is inserted twice', async () => {
				const store = await create();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				const first = await store.submissions.listAttemptMarkers();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listAttemptMarkers()).toEqual(first);
			});

			it('deletes only the marker matching both submission and attempt', async () => {
				const store = await create();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-2'));
				await store.submissions.deleteAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listAttemptMarkers()).toEqual([
					expect.objectContaining({ submissionId: 'dispatch-1', attemptId: 'attempt-2' }),
				]);
			});

			it('silently handles deleting nonexistent markers', async () => {
				const store = await create();
				await expect(
					store.submissions.deleteAttemptMarker(attempt('missing', 'attempt-1')),
				).resolves.toBeUndefined();
			});
		});

		// ── Lease management ────────────────────────────────────────────────

		describe('renewLeases()', () => {
			it('extends lease timestamp for owned running submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const expiry = Date.now() + 5_000;
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: expiry,
				});
				await store.submissions.renewLeases('owner-a', ['dispatch-1']);
				const submission = await store.submissions.getSubmission('dispatch-1');
				if (!submission) throw new Error('Expected renewed submission to exist.');
				expect(submission.leaseExpiresAt).toBeGreaterThan(expiry);
			});

			it('ignores submissions owned by a different coordinator', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const expiry = Date.now() + 5_000;
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: expiry,
				});
				await store.submissions.renewLeases('owner-b', ['dispatch-1']);
				const submission = await store.submissions.getSubmission('dispatch-1');
				if (!submission) throw new Error('Expected submission to exist.');
				expect(submission.leaseExpiresAt).toBe(expiry);
			});

			it('ignores settled submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				// Should not throw — settled submissions are silently skipped.
				await store.submissions.renewLeases('test-owner', ['dispatch-1']);
			});
		});

		describe('listExpiredSubmissions()', () => {
			it('returns running submissions with expired leases', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: 1, // expired in the past
				});
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(1);
				const submission = expired[0];
				if (!submission) throw new Error('Expected one expired submission.');
				expect(submission.submissionId).toBe('dispatch-1');
			});

			it('excludes submissions with future lease expiry', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: Date.now() + 60_000,
				});
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});

			it('excludes settled submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: 1,
				});
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});

			it('returns empty when no submissions exist', async () => {
				const store = await create();
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});
		});

		// ── Edge cases ──────────────────────────────────────────────────────

		describe('edge cases', () => {
			it('reports no unsettled submissions initially', async () => {
				const store = await create();
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
			});

			it('getSubmission returns null for unknown ids', async () => {
				const store = await create();
				expect(await store.submissions.getSubmission('nonexistent')).toBeNull();
			});

			it('getTurnJournal returns null for unknown submissions', async () => {
				const store = await create();
				expect(await store.submissions.getTurnJournal('nonexistent')).toBeNull();
			});
		});
	});
}
