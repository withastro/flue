import type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
} from '../agent-execution-store.ts';
import { LEASE_DURATION_MS } from '../agent-execution-store.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	type AgentSubmissionInput,
	type AttachedAgentSubmissionAdmission,
	createAgentSubmissionObserverRegistry,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	materializeAgentSubmissionSession,
	processSubmission,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import type { AgentInteractionStart } from '../runtime/dev-lifecycle-logger.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';
import { agentStreamPath } from '../runtime/event-stream-store.ts';
import type { CreateAgentContextFn } from '../runtime/handle-agent.ts';
import type { RuntimeActivityGate, RuntimeActivityLease } from '../runtime/runtime-activity-gate.ts';
import type {
	AgentDefinition,
	AttachedAgentEvent,
	DirectAgentPayload,
	DispatchReceipt,
} from '../types.ts';

export interface NodeAgentCoordinator {
	/** Call once at startup to reconcile interrupted work from a previous process. */
	reconcileSubmissions(): Promise<void>;
	/** Admit a dispatch. The submission is persisted durably; processing is asynchronous. */
	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
	/**
	 * Create a durable admission hook for a specific agent instance. The returned
	 * function accepts a direct prompt payload, persists it as a durable submission,
	 * and resolves when the submission settles. Pass the result as the
	 * `admitAttachedSubmission` option to `handleAgentRequest()` so that direct
	 * prompts enter the same durable lifecycle as dispatches.
	 */
	createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission;
	/**
	 * Resolves when all active submissions have settled and no runnable work remains.
	 * Useful for tests and graceful shutdown.
	 */
	waitForIdle(): Promise<void>;
	/**
	 * Graceful shutdown. Stops accepting new work, aborts active submissions
	 * at the turn boundary, and waits for settlement with a timeout. Submissions
	 * that don't settle within the timeout are abandoned — their expired leases
	 * will be reclaimed on next startup via {@link reconcileSubmissions}.
	 */
	shutdown(timeoutMs?: number): Promise<void>;
}

/**
 * Create a `DispatchQueue` backed by a `NodeAgentCoordinator`.
 *
 * Dispatches go through proper SQL admission, claim, journal callbacks,
 * and settlement instead of fire-and-forget inline processing. The
 * coordinator also reconciles interrupted work from a previous process
 * on startup and drains queued submissions after each dispatch.
 */
export function createNodeDispatchQueue(coordinator: NodeAgentCoordinator): DispatchQueue {
	return {
		async enqueue(input: DispatchInput): Promise<DispatchReceipt> {
			// Admission is durable — the submission is persisted in SQL. Processing
			// happens asynchronously via the coordinator's claim loop. Admission
			// outcomes mirror the Cloudflare coordinator: an exact replay returns
			// the original stored receipt and a conflicting replay throws.
			const admission = await coordinator.admitDispatch(input);
			if (admission.kind === 'retained_receipt') {
				return {
					dispatchId: admission.receipt.submissionId,
					acceptedAt: new Date(admission.receipt.acceptedAt).toISOString(),
				};
			}
			if (admission.kind === 'conflict') {
				throw new Error(
					`[flue] dispatch() target agent "${input.agent}" rejected a conflicting dispatch replay.`,
				);
			}
			return {
				dispatchId: admission.submission.submissionId,
				acceptedAt: input.acceptedAt,
			};
		},
	};
}

export function createNodeAgentCoordinator(options: {
	submissions: AgentSubmissionStore;
	agents: ReadonlyArray<{ name: string; definition: AgentDefinition }>;
	createContext: CreateAgentContextFn;
	conversationStreamStore?: ConversationStreamStore;
	conversationSnapshotStore?: ConversationSnapshotStore;
	attachmentStore?: AttachmentStore;
	onInteractionStart?: (interaction: AgentInteractionStart) => void;
	activityGate?: RuntimeActivityGate;
}): NodeAgentCoordinator {
	const { submissions, agents, createContext, conversationStreamStore, conversationSnapshotStore, attachmentStore, onInteractionStart, activityGate } = options;
	const observers = createAgentSubmissionObserverRegistry();
	const conversationWriters = new Map<string, Promise<ConversationRecordWriter>>();
	const conversationMaterializations = new Map<string, Promise<void>>();

	// ── Lease ownership ──────────────────────────────────────────────────

	/** Unique identifier for this coordinator instance. Used as the owner
	 *  for lease-based submission ownership. */
	const ownerId = crypto.randomUUID();

	/** Heartbeat interval handle; started with the claim loop. */
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	/** Periodic lease-scan wake timer; wakes the claim loop so expired
	 *  leases are discovered even when no new work arrives. */
	let leaseScanInterval: ReturnType<typeof setInterval> | null = null;

	// ── Concurrent claim loop state ──────────────────────────────────────

	/** Submissions currently being processed, keyed by submissionId. */
	const activeSubmissions = new Map<string, { task: Promise<void>; abort: AbortController }>();
	const activityLeases = new Map<string, RuntimeActivityLease>();

	/**
	 * Wake signal. The claim loop sleeps on `wakePromise` when there is
	 * nothing to do. Callers resolve it via `wake()` to trigger a new
	 * claim pass. The loop re-creates the promise each iteration.
	 */
	let wakeResolve: (() => void) | null = null;
	let wakePromise: Promise<void> | null = null;

	/**
	 * When a claim pass is already running, `wake()` sets this flag so
	 * the current pass loops again after finishing its claims. Same
	 * cooperative pattern as the old `driveAgainRequested`.
	 */
	let claimPassRunning = false;
	let wakeRequested = false;

	/** Whether the claim loop has been started. */
	let loopRunning = false;

	/** Whether the coordinator is shutting down. When true, the claim
	 *  loop stops claiming new work and admissions are rejected. */
	let stopping = false;

	function resetWakePromise(): void {
		wakePromise = new Promise<void>((resolve) => {
			wakeResolve = resolve;
		});
	}

	function wake(): void {
		if (claimPassRunning) {
			wakeRequested = true;
			return;
		}
		if (wakeResolve) {
			const resolve = wakeResolve;
			wakeResolve = null;
			resolve();
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	function getConversationWriter(input: AgentSubmissionInput): Promise<ConversationRecordWriter | undefined> {
		if (!conversationStreamStore) return Promise.resolve(undefined);
		const path = agentStreamPath(input.agent, input.id);
		let writer = conversationWriters.get(path);
		if (!writer) {
			writer = ConversationRecordWriter.create({
				store: conversationStreamStore,
				path,
				identity: { agentName: input.agent, instanceId: input.id },
				producerId: ownerId,
				snapshots: conversationSnapshotStore,
			});
			conversationWriters.set(path, writer);
			void writer.catch(() => {
				if (conversationWriters.get(path) === writer) conversationWriters.delete(path);
			});
		}
		return writer;
	}

	function makeSubmissionContext(input: AgentSubmissionInput, writer: ConversationRecordWriter | undefined) {
		return (dispatchId: string | undefined) => {
			const ctx = createContext({
				id: input.id,
				agentName: input.agent,
				request: submissionSyntheticRequest(input),
				dispatchId,
			});
			ctx.setConversationWriter?.(writer);
			ctx.setAttachmentStore?.(attachmentStore);
			return ctx;
		};
	}

	function materializeSubmissionConversation(
		input: AgentSubmissionInput,
		agent: AgentDefinition,
	): Promise<void> {
		const path = agentStreamPath(input.agent, input.id);
		const previous = conversationMaterializations.get(path) ?? Promise.resolve();
		const materialized = previous.then(async () => {
			const writer = await getConversationWriter(input);
			const ctx = makeSubmissionContext(input, writer)(
				input.kind === 'dispatch' ? input.dispatchId : undefined,
			);
			await materializeAgentSubmissionSession(ctx, agent, input, attachmentStore);
		});
		conversationMaterializations.set(path, materialized);
		void materialized.then(
			() => {
				if (conversationMaterializations.get(path) === materialized) {
					conversationMaterializations.delete(path);
				}
			},
			() => {
				if (conversationMaterializations.get(path) === materialized) {
					conversationMaterializations.delete(path);
				}
			},
		);
		return materialized;
	}

	function resolveAgent(name: string): AgentDefinition {
		const agent = agents.find((record) => record.name === name)?.definition;
		if (!agent) throw new Error(`[flue] submission target agent "${name}" has no agent definition.`);
		return agent;
	}

	/**
	 * Start processing a claimed submission as an independent async task.
	 * Adds itself to `activeSubmissions`, removes on completion, and
	 * wakes the claim loop so it can pick up newly-runnable work (e.g.
	 * the next queued submission for the same session).
	 */
	function spawnSubmissionTask(claimed: AgentSubmission): void {
		const controller = new AbortController();
		const task = (async () => {
			const conversationWriter = await getConversationWriter(claimed.input);
			return processSubmission({
				submissions,
				submission: claimed,
				resolveAgent,
				createContext: makeSubmissionContext(claimed.input, conversationWriter),
				observers,
				conversationWriter,
				onInteractionStart,
				signal: controller.signal,
				isShutdownAbort: (error) =>
					stopping && error instanceof DOMException && error.name === 'AbortError',
			});
		})()
			.catch((error) => {
				// AbortErrors during shutdown are expected — don't log them.
				if (error instanceof DOMException && error.name === 'AbortError') return;
				console.error(
					'[flue:submission-processing]',
					{
						submissionId: claimed.submissionId,
						operation: 'process_submission',
						outcome: 'failed',
					},
					error,
				);
			})
			.finally(() => {
				activeSubmissions.delete(claimed.submissionId);
				activityLeases.get(claimed.submissionId)?.release();
				activityLeases.delete(claimed.submissionId);
				wake();
			});
		activeSubmissions.set(claimed.submissionId, { task, abort: controller });
	}

	// ── Claim loop ───────────────────────────────────────────────────────

	/**
	 * Run a single claim pass: list runnable submissions, attempt to
	 * claim each, and spawn processing tasks for successful claims.
	 * Returns whether any progress was made.
	 */
	async function runClaimPass(): Promise<boolean> {
		await reconcileUnreadySubmissions();
		// Periodically scan for expired leases from other coordinators.
		await periodicLeaseScan();
		const runnable = await submissions.listRunnableSubmissions();
		let progressed = false;
		for (const submission of runnable) {
			// Skip submissions already being processed in this coordinator
			// (possible if a wake arrived between listing and claiming).
			if (activeSubmissions.has(submission.submissionId)) continue;
			const claimed = await submissions.claimSubmission({
				submissionId: submission.submissionId,
				attemptId: crypto.randomUUID(),
				ownerId,
				leaseExpiresAt: Date.now() + LEASE_DURATION_MS,
			});
			if (!claimed) continue;
			progressed = true;
			spawnSubmissionTask(claimed);
		}
		return progressed;
	}

	/**
	 * Persistent claim loop. Runs for the lifetime of the coordinator.
	 * Woken by admissions and submission settlements.
	 *
	 * The wake mechanism has two modes:
	 * - **Flag mode** (`claimPassRunning = true`): `wake()` sets `wakeRequested`
	 *   so the current pass re-checks after finishing.
	 * - **Promise mode** (`claimPassRunning = false`): `wake()` resolves the
	 *   sleep promise to start a new pass.
	 *
	 * To avoid losing wakes in the transition between modes, the sleep
	 * promise is reset BEFORE `claimPassRunning` is cleared, and
	 * `wakeRequested` is checked after clearing the flag.
	 */
	async function claimLoop(): Promise<void> {
		while (!stopping) {
			claimPassRunning = true;
			try {
				let progressed: boolean;
				do {
					wakeRequested = false;
					progressed = await runClaimPass();
					// Keep looping if we made progress (newly-runnable work may
					// have appeared due to session-head advancement) or if a
					// wake was requested during this pass.
				} while (progressed || wakeRequested);
			} catch (error) {
				// A transient DB error in listRunnableSubmissions or
				// claimSubmission should not kill the entire loop. Log,
				// back off briefly, and retry. Setting wakeRequested ensures
				// the loop retries immediately after the backoff instead of
				// sleeping indefinitely waiting for an external wake.
				console.error('[flue:claim-loop] Error in claim pass, retrying:', error);
				await new Promise<void>((r) => setTimeout(r, 1000));
				wakeRequested = true;
			} finally {
				// Reset the sleep promise BEFORE clearing claimPassRunning.
				// This ensures any wake() arriving in the gap between
				// clearing the flag and sleeping resolves the NEW promise,
				// not a stale one.
				resetWakePromise();
				claimPassRunning = false;
			}

			// If a wake arrived between the end of the do/while and
			// claimPassRunning being cleared, it set wakeRequested.
			// Don't sleep — loop again immediately.
			if (wakeRequested) {
				wakeRequested = false;
				continue;
			}
			await wakePromise;
		}
	}

	/** Start the claim loop and lease heartbeat if not already running. */
	function ensureClaimLoop(): void {
		if (loopRunning) return;
		loopRunning = true;
		// Fire-and-forget — the loop runs for the coordinator's lifetime.
		// Errors in individual submissions are caught by spawnSubmissionTask.
		// Unexpected errors in the loop itself are fatal and logged.
		void claimLoop().catch((error) => {
			console.error('[flue:claim-loop] Fatal error in claim loop:', error);
			loopRunning = false;
		});
		// Start lease heartbeat: periodically renew leases for all active
		// submissions so they aren't reclaimed by another coordinator.
		if (!heartbeatInterval) {
			const HEARTBEAT_INTERVAL_MS = 10_000;
			heartbeatInterval = setInterval(() => {
				const ids = [...activeSubmissions.keys()];
				if (ids.length === 0) return;
				submissions.renewLeases(ownerId, ids).catch((error) => {
					console.error('[flue:lease-heartbeat] Failed to renew leases:', error);
				});
			}, HEARTBEAT_INTERVAL_MS);
			// Don't let the heartbeat prevent process exit.
			if (typeof heartbeatInterval === 'object' && 'unref' in heartbeatInterval) {
				heartbeatInterval.unref();
			}
		}
		// Start periodic lease-scan wake: ensures the claim loop wakes up
		// to discover expired leases even when no new work is being admitted.
		// Without this, a sleeping claim loop would never check for stale
		// submissions left by a crashed previous process.
		if (!leaseScanInterval) {
			leaseScanInterval = setInterval(() => wake(), LEASE_SCAN_INTERVAL_MS);
			if (typeof leaseScanInterval === 'object' && 'unref' in leaseScanInterval) {
				leaseScanInterval.unref();
			}
		}
	}

	// ── Reconciliation ───────────────────────────────────────────────────

	/** Interval (ms) between periodic expired-lease scans in the claim loop. */
	const LEASE_SCAN_INTERVAL_MS = 15_000;
	/** Timestamp of the last expired-lease scan. */
	let lastLeaseScanAt = 0;

	/**
	 * Check for expired leases periodically during the claim loop. This
	 * catches submissions stranded when a replacement process starts before
	 * the old process's 30s lease expires. Without this, `reconcileSubmissions`
	 * at startup would miss still-leased submissions and they'd be stranded
	 * until the next full restart after the lease expires.
	 */
	async function periodicLeaseScan(): Promise<void> {
		const now = Date.now();
		if (now - lastLeaseScanAt < LEASE_SCAN_INTERVAL_MS) return;
		lastLeaseScanAt = now;
		await reconcileRunningSubmissions();
	}

	/** In-flight expired-lease reconciliation pass, if any. */
	let reconcilePassInFlight: Promise<void> | null = null;

	/**
	 * Reconcile submissions whose leases have expired. Single-flight:
	 * concurrent callers share one pass instead of running two. Without
	 * this, startup's `reconcileSubmissions()` and the claim loop's first
	 * `periodicLeaseScan` (started by `ensureClaimLoop` just before the
	 * direct call) would each list the same expired submissions and run
	 * `reconcileInterruptedSubmission` twice per submission with
	 * independent fresh Sessions — the journal-attempt CAS picks one
	 * winner, and the loser can append a spurious interruption advisory
	 * to session history before its settlement CAS is rejected.
	 */
	function reconcileRunningSubmissions(): Promise<void> {
		reconcilePassInFlight ??= runReconciliationPass().finally(() => {
			reconcilePassInFlight = null;
		});
		return reconcilePassInFlight;
	}

	async function reconcileUnreadySubmissions(): Promise<void> {
		for (const submission of await submissions.listUnreadySubmissions()) {
			const agent = agents.find((record) => record.name === submission.input.agent)?.definition;
			if (!agent) {
				console.error('[flue:submission-reconciliation]', {
					submissionId: submission.submissionId,
					operation: 'materialize_submission',
					outcome: 'agent_unavailable',
				});
				continue;
			}
			try {
				await materializeSubmissionConversation(submission.input, agent);
				await submissions.markSubmissionCanonicalReady(submission.submissionId);
			} catch (error) {
				console.error(
					'[flue:submission-reconciliation]',
					{
						submissionId: submission.submissionId,
						operation: 'materialize_submission',
						outcome: 'failed',
					},
					error,
				);
			}
		}
	}

	async function runReconciliationPass(): Promise<void> {
		await reconcileUnreadySubmissions();
		for (const settlement of await submissions.listPendingSubmissionSettlements()) {
			const submission = await submissions.getSubmission(settlement.submissionId);
			if (!submission || submission.kind !== 'direct') continue;
			if (activeSubmissions.has(submission.submissionId) || submission.leaseExpiresAt > Date.now()) {
				continue;
			}
			const writer = await getConversationWriter(submission.input);
			if (!writer) continue;
			const attempt = { submissionId: settlement.submissionId, attemptId: settlement.attemptId };
			const canonical = await writer.getRecord(settlement.recordId);
			if (!canonical) await writer.append([settlement.record], { submission: attempt });
			else if (JSON.stringify(canonical) !== JSON.stringify(settlement.record)) {
				throw new Error('[flue] Pending settlement does not match its canonical record. Clear incompatible beta persistence.');
			}
			if (await submissions.finalizeSubmissionSettlement(attempt, settlement.recordId)) {
				if (settlement.record.outcome === 'completed') observers.complete(settlement.submissionId, settlement.record.result);
				if (settlement.record.outcome === 'failed') {
					const error = settlement.record.error as { message?: string } | undefined;
					observers.fail(settlement.submissionId, new Error(error?.message ?? 'Agent submission failed.'));
				}
			}
		}
		for (const submission of await submissions.listExpiredSubmissions()) {
			// Skip submissions still actively processing in this coordinator
			// (possible when heartbeat renewals fail transiently and the lease
			// expires while the task is mid-flight). Reconciling our own live
			// submission would spawn a second concurrent task for the same
			// session — exactly the corruption leases exist to prevent.
			if (activeSubmissions.has(submission.submissionId)) continue;
			const agentName = submission.input.agent;
			const agent = agents.find((record) => record.name === agentName)?.definition;
			if (!agent) {
				console.error('[flue:submission-reconciliation]', {
					submissionId: submission.submissionId,
					operation: 'reconcile_submission',
					outcome: 'agent_unavailable',
				});
				continue;
			}
			try {
				const conversationWriter = await getConversationWriter(submission.input);
				const reconciled = await reconcileInterruptedSubmission(
					submissions,
					submission,
					agent,
					makeSubmissionContext(submission.input, conversationWriter),
					{ ownerId, leaseExpiresAt: Date.now() + LEASE_DURATION_MS },
					conversationWriter,
				);
				if (reconciled.disposition === 'replacement') {
					spawnSubmissionTask(reconciled.submission);
				} else if (submission.kind === 'direct') {
					// Observer resolution is best-effort and per-process: only
					// a waiting caller attached in this process can be resolved
					// here. Detached observers see the durable settlement event.
					if (reconciled.disposition === 'completed') {
						observers.complete(submission.submissionId, reconciled.result);
					} else if (reconciled.disposition === 'failed') {
						observers.fail(submission.submissionId, reconciled.error);
					}
				}
			} catch (error) {
				console.error(
					'[flue:submission-reconciliation]',
					{
						submissionId: submission.submissionId,
						operation: 'reconcile_submission',
						outcome: 'failed',
					},
					error,
				);
			}
		}
	}

	// ── Public interface ─────────────────────────────────────────────────

	return {
		async reconcileSubmissions() {
			if (!(await submissions.hasUnsettledSubmissions())) return;
			await reconcileUnreadySubmissions();
			// Start the claim loop first so that settlement wakes from
			// reconciled submissions are properly received.
			ensureClaimLoop();
			await reconcileRunningSubmissions();
			// Wait for all reconciled and subsequently-runnable submissions to
			// settle. Reconciliation may requeue submissions (putting them back
			// to 'queued'), which the claim loop then picks up.
			await this.waitForIdle();
		},

		async admitDispatch(input) {
			if (stopping) throw new Error('[flue] Coordinator is shutting down.');
			const activityLease = activityGate?.enter();
			try {
				const agent = agents.find((record) => record.name === input.agent)?.definition;
				if (!agent) {
					throw new Error(`[flue] dispatch target agent "${input.agent}" has no agent definition.`);
				}

				const admission = await submissions.admitDispatch(input);
				if (admission.kind !== 'submission') {
					activityLease?.release();
					return admission;
				}
				let submission = admission.submission;
				if (submission.canonicalReadyAt === null) {
					try {
						await materializeSubmissionConversation(createDispatchAgentSubmissionInput(input), agent);
						submission =
							(await submissions.markSubmissionCanonicalReady(submission.submissionId)) ?? submission;
					} catch (error) {
						throw error;
					}
				}

				if (activityLease) activityLeases.set(submission.submissionId, activityLease);
				ensureClaimLoop();
				wake();
				return { kind: 'submission', submission };
			} catch (error) {
				activityLease?.release();
				throw error;
			}
		},

		createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission {
			return async (
				payload: DirectAgentPayload,
				onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
				waitForResult?: boolean,
				traceCarrier?: import('../execution-interceptor.ts').FlueTraceCarrier,
			) => {
				waitForResult ??= true;
				if (stopping) throw new Error('[flue] Coordinator is shutting down.');
				const activityLease = activityGate?.enter();
				const agent = agents.find((record) => record.name === agentName)?.definition;
				if (!agent) {
					activityLease?.release();
					throw new Error(`[flue] direct prompt target agent "${agentName}" has no agent definition.`);
				}

				const input = createDirectAgentSubmissionInput({
					agent: agentName,
					id: instanceId,
					payload,
					traceCarrier,
				});

				const attachment = observers.attach(input.submissionId, { onEvent });
				try {
					const admitted = await submissions.admitDirect(input);
					if (admitted.canonicalReadyAt === null) {
						try {
							await materializeSubmissionConversation(input, agent);
							const ready = await submissions.markSubmissionCanonicalReady(input.submissionId);
							if (!ready) throw new Error('[flue] Direct admission disappeared before canonical readiness.');
						} catch (error) {
							throw error;
						}
					}
					const writer = await getConversationWriter(input);
					const offset = writer?.offset ?? '-1';
					if (activityLease) activityLeases.set(input.submissionId, activityLease);
					ensureClaimLoop();
					wake();
					if (!waitForResult) return { submissionId: input.submissionId, offset };
					return { submissionId: input.submissionId, offset, result: await attachment.completion };
				} catch (error) {
					activityLease?.release();
					observers.fail(input.submissionId, error);
					throw error;
				} finally {
					attachment.detach();
				}
			};
		},

		async waitForIdle() {
			// Wait for all active submissions to settle, then verify no new
			// runnable work appeared (e.g. from session-head advancement).
			while (true) {
				if (stopping) return;
				if (activeSubmissions.size > 0) {
					await Promise.allSettled([...activeSubmissions.values()].map((s) => s.task));
				}
				if (stopping) return;
				// Give the claim loop a chance to pick up any newly-runnable
				// work that appeared from settlement (session-head advancement).
				// A short yield lets the claim loop's wake() → runClaimPass()
				// cycle execute.
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
				if (activeSubmissions.size === 0) {
					// Double-check no runnable work exists.
					const runnable = await submissions.listRunnableSubmissions();
					if (runnable.length === 0) break;
					if (stopping) return;
					// Runnable work exists — wake the loop and wait again.
					wake();
				}
			}
		},

		async shutdown(timeoutMs = 30_000) {
			if (stopping) return;
			stopping = true;

			// Wake the claim loop so it exits (checks `stopping` flag).
			wake();

			// Abort all active submissions at the turn boundary. The abort
			// signal propagates into the session, which finishes the current
			// turn and throws AbortError. processSubmission's catch block
			// skips failSubmission during shutdown so the submission stays
			// in 'running' — its expired lease will trigger reclamation on
			// next startup.
			for (const { abort } of activeSubmissions.values()) {
				abort.abort(new DOMException('Coordinator shutting down.', 'AbortError'));
			}

			// Wait for active submissions to reach the turn boundary within
			// the timeout. The heartbeat keeps running so leases stay valid
			// while work is still settling — this prevents a concurrent
			// coordinator from reclaiming submissions that are still active.
			if (activeSubmissions.size > 0) {
				const settlement = Promise.allSettled([...activeSubmissions.values()].map((s) => s.task));
				const timeout = new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					settlement.finally(() => clearTimeout(timer));
				});
				await Promise.race([settlement, timeout]);
			}

			// Stop the heartbeat and lease-scan timer after settlement (or
			// timeout). Submissions that didn't settle will have their leases
			// expire naturally, making them eligible for reclamation on next
			// startup.
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			if (leaseScanInterval) {
				clearInterval(leaseScanInterval);
				leaseScanInterval = null;
			}

			if (activeSubmissions.size > 0) {
				const abandoned = [...activeSubmissions.keys()];
				console.error(
					`[flue:shutdown] ${abandoned.length} submission(s) did not settle within ${timeoutMs}ms and will be reclaimed on next startup:`,
					abandoned,
				);
			}
		},
	};
}
