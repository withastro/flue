import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type { AgentSubmission, AgentSubmissionStore } from '../agent-execution-store.ts';
import { LEASE_DURATION_MS } from '../agent-execution-store.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	classifyError,
	RuntimeUnavailableError,
	SubmissionAbortedError,
	SubmissionConflictError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { createMcpConnectionCache, type McpConnectionCache } from '../mcp.ts';
import {
	type AgentSubmissionInput,
	type AttachedAgentSubmissionAdmission,
	admitInstanceContact,
	adoptKeyedSubmissionReplay,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	emitSubmissionAttemptChanged,
	ensureInstanceIdentity,
	finalizePendingSettlement,
	type InstanceContactAdmission,
	type InstanceIdentity,
	isInstanceContactRejection,
	materializeSubmissionAttachments,
	processSubmission,
	reconcileInterruptedSubmission,
	serializeSubmissionError,
	settleUnclaimableSubmission,
	submissionSyntheticRequest,
	unreadySubmissionDeadline,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';
import {
	type CoordinatorEventEmitter,
	createCoordinatorEventEmitter,
} from '../runtime/events.ts';
import type { CreateAgentContextFn } from '../runtime/handle-agent.ts';
import { generateAttemptId, generateOwnerId, isKeyDerivedSubmissionId } from '../runtime/ids.ts';
import type { RuntimeActivityGate } from '../runtime/runtime-activity-gate.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import { createSessionStorageKey } from '../session-identity.ts';
import type { Agent, DeliveredMessage, DispatchReceipt } from '../types.ts';

export interface NodeAgentCoordinator {
	/** Call once at startup to reconcile interrupted work from a previous process. */
	reconcileSubmissions(): Promise<void>;
	/**
	 * Admit a dispatch. The submission is persisted durably; processing is
	 * asynchronous. `uid` is the contacted instance's uid (recorded at birth
	 * for a creating send, read back for the receipt). `deduplicated` is set
	 * when a keyed admission converged on the submission its key already
	 * names instead of admitting a new one.
	 */
	admitDispatch(
		input: DispatchInput,
	): Promise<
		| {
				readonly kind: 'submission';
				readonly submission: AgentSubmission;
				readonly uid: string;
				readonly deduplicated?: true;
		  }
		| { readonly kind: 'conflict' }
	>;
	/**
	 * Abort all in-flight and queued durable work for an agent instance. Records
	 * the durable abort intent on every unsettled submission for the instance
	 * and aborts any attempt running in this process. Terminal settlement (the
	 * distinct aborted outcome) happens asynchronously; observe it via the
	 * conversation/result. Resolves `true` when there was unsettled work to
	 * abort, `false` when the instance was idle.
	 */
	abortInstance(agentName: string, instanceId: string): Promise<boolean>;
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
 * Dispatches go through proper SQL admission, claim, and settlement
 * instead of fire-and-forget inline processing. The
 * coordinator also reconciles interrupted work from a previous process
 * on startup and drains queued submissions after each dispatch.
 */
export function createNodeDispatchQueue(coordinator: NodeAgentCoordinator): DispatchQueue {
	return {
		async enqueue(input: DispatchInput): Promise<DispatchReceipt> {
			// Admission is durable — the submission is persisted in SQL. Processing
			// happens asynchronously via the coordinator's claim loop. Admission
			// outcomes mirror the Cloudflare coordinator: an exact replay returns
			// the original stored submission and a conflicting replay throws.
			const admission = await coordinator.admitDispatch(input);
			if (admission.kind === 'conflict') {
				throw new SubmissionConflictError({ submissionId: input.submissionId });
			}
			return {
				submissionId: admission.submission.submissionId,
				// The stored row's timestamp, so a deduplicated replay echoes the
				// ORIGINAL admission's receipt (identical on a fresh admission).
				acceptedAt: admission.submission.input.acceptedAt,
				uid: admission.uid,
				...(admission.deduplicated ? { deduplicated: true as const } : {}),
			};
		},
	};
}

export function createNodeAgentCoordinator(options: {
	submissions: AgentSubmissionStore;
	agents: ReadonlyArray<{ name: string; agent: Agent }>;
	createContext: CreateAgentContextFn;
	conversationStreamStore?: ConversationStreamStore;
	attachmentStore?: AttachmentStore;
	/** Runtime environment stamped on coordinator-emitted events' contexts. */
	env?: Record<string, unknown>;
	activityGate?: RuntimeActivityGate;
}): NodeAgentCoordinator {
	const {
		submissions,
		agents,
		createContext,
		conversationStreamStore,
		attachmentStore,
		activityGate,
	} = options;
	const coordinatorEnv = options.env ?? {};
	const conversationWriters = new Map<string, Promise<ConversationRecordWriter>>();
	const conversationMaterializations = new Map<string, Promise<unknown>>();
	// Live MCP connections, keyed per instance stream path like the writers
	// above: submissions reuse an instance's connections for the process
	// lifetime, and shutdown closes them all.
	const mcpConnectionCaches = new Map<string, McpConnectionCache>();

	// ── Coordinator event emitters ───────────────────────────────────────
	// Context-free live emitters for coordinator signals (`submission_queued`,
	// `submission_recovery`, recovered settlements): one per instance the
	// coordinator touches (the Node coordinator is process-wide), plus a
	// scope-less one for pass-wide failures with no submission in hand.
	// Independent of context/writer creation — among the failures reported —
	// and infallible by contract.
	const passEventEmitter = createCoordinatorEventEmitter({ env: coordinatorEnv });
	const instanceEventEmitters = new Map<string, CoordinatorEventEmitter>();
	function coordinatorEventEmitter(input?: {
		agent: string;
		id: string;
	}): CoordinatorEventEmitter {
		if (!input) return passEventEmitter;
		const key = agentStreamPath(input.agent, input.id);
		let emitter = instanceEventEmitters.get(key);
		if (!emitter) {
			emitter = createCoordinatorEventEmitter({
				agentName: input.agent,
				instanceId: input.id,
				env: coordinatorEnv,
			});
			instanceEventEmitters.set(key, emitter);
		}
		return emitter;
	}

	// ── Lease ownership ──────────────────────────────────────────────────

	/** Unique identifier for this coordinator instance. Used as the owner
	 *  for lease-based submission ownership. */
	const ownerId = generateOwnerId();

	/** Heartbeat interval handle; started with the claim loop. */
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	/** Periodic lease-scan wake timer; wakes the claim loop so expired
	 *  leases are discovered even when no new work arrives. */
	let leaseScanInterval: ReturnType<typeof setInterval> | null = null;

	// ── Concurrent claim loop state ──────────────────────────────────────

	/** Submissions currently being processed, keyed by submissionId. */
	const activeSubmissions = new Map<string, { task: Promise<void>; abort: AbortController }>();

	/**
	 * Wake signal. The claim loop sleeps on `wakePromise` when there is
	 * nothing to do. Callers resolve it via `wake()` to trigger a new
	 * claim pass. The loop re-creates the promise each iteration.
	 */
	let wakeResolve: (() => void) | null = null;
	let wakePromise: Promise<void> | null = null;

	/**
	 * When a claim pass is already running, `wake()` sets this flag so
	 * the current pass loops again after finishing its claims.
	 */
	let claimPassRunning = false;
	let wakeRequested = false;

	let loopRunning = false;

	/**
	 * The running claim loop's completion. `shutdown()` awaits it so no
	 * claim pass can still be touching the stores when shutdown resolves —
	 * callers close the persistence adapter right after, and an in-flight
	 * `listRunnableSubmissions` would otherwise race the close and log
	 * "database is not open" retries.
	 */
	let claimLoopDone: Promise<void> | null = null;

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

	function getConversationWriter(
		input: AgentSubmissionInput,
	): Promise<ConversationRecordWriter | undefined> {
		if (!conversationStreamStore) return Promise.resolve(undefined);
		const path = agentStreamPath(input.agent, input.id);
		let writer = conversationWriters.get(path);
		if (!writer) {
			writer = ConversationRecordWriter.create({
				store: conversationStreamStore,
				path,
				identity: { agentName: input.agent, instanceId: input.id },
				producerId: ownerId,
				onFailed: () => {
					if (conversationWriters.get(path) === writer) conversationWriters.delete(path);
				},
			});
			conversationWriters.set(path, writer);
			void writer.catch(() => {
				if (conversationWriters.get(path) === writer) conversationWriters.delete(path);
			});
		}
		return writer;
	}

	function getMcpConnections(input: AgentSubmissionInput): McpConnectionCache {
		const path = agentStreamPath(input.agent, input.id);
		let cache = mcpConnectionCaches.get(path);
		if (!cache) {
			cache = createMcpConnectionCache();
			mcpConnectionCaches.set(path, cache);
		}
		return cache;
	}

	function makeSubmissionContext(
		input: AgentSubmissionInput,
		writer: ConversationRecordWriter | undefined,
	) {
		return (submissionId: string) => {
			const ctx = createContext({
				id: input.id,
				agentName: input.agent,
				request: submissionSyntheticRequest(input),
				submissionId,
			});
			ctx.setConversationWriter?.(writer);
			ctx.setAttachmentStore?.(attachmentStore);
			ctx.setMcpConnections?.(getMcpConnections(input));
			return ctx;
		};
	}

	/**
	 * Admission-side materialization, serialized per stream path: ensure the
	 * instance's birth record (find-or-create, no render, no sandbox) and
	 * persist the message's attachments under its conversation id. Idempotent —
	 * admission, replays, and the unready-row recovery pass all run it safely.
	 * Returns the identity for the receipt; `undefined` without a conversation
	 * store (storeless configs have nothing durable to materialize).
	 */
	function materializeSubmissionConversation(
		input: AgentSubmissionInput,
		agent: Agent,
	): Promise<InstanceIdentity | undefined> {
		const path = agentStreamPath(input.agent, input.id);
		const previous = conversationMaterializations.get(path) ?? Promise.resolve();
		const materialized = previous.then(async () => {
			const writer = await getConversationWriter(input);
			if (!writer) return undefined;
			const identity = await ensureInstanceIdentity(writer, agent, input.initialData);
			await materializeSubmissionAttachments(input, identity.conversationId, attachmentStore);
			return identity;
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

	function resolveAgent(name: string): Agent {
		const agent = agents.find((record) => record.name === name)?.agent;
		if (!agent)
			throw new Error(`[flue] submission target agent "${name}" has no agent definition.`);
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
		const emitCoordinatorEvent = coordinatorEventEmitter(claimed.input);
		const task = (async () => {
			const conversationWriter = await getConversationWriter(claimed.input);
			return processSubmission({
				submissions,
				submission: claimed,
				resolveAgent,
				createContext: makeSubmissionContext(claimed.input, conversationWriter),
				conversationWriter,
				emitCoordinatorEvent,
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
				// Usually post-settlement (processSubmission settles failed
				// durably and emits the live submission_settled before
				// rethrowing); when the failure struck settlement itself the row
				// is still unsettled and reconciliation owns it.
				emitCoordinatorEvent(
					{
						type: 'submission_recovery',
						submissionId: claimed.submissionId,
						kind: claimed.kind,
						operation: 'process_submission',
						outcome: 'deferred',
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
				);
			})
			.finally(() => {
				activeSubmissions.delete(claimed.submissionId);
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
		// Claiming new work during shutdown would spawn tasks the
		// active-submission abort sweep already ran past.
		if (stopping) return false;
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
				attemptId: generateAttemptId(),
				ownerId,
				leaseExpiresAt: Date.now() + LEASE_DURATION_MS,
			});
			if (!claimed) continue;
			emitSubmissionAttemptChanged(
				submission,
				claimed,
				'claim_submission',
				coordinatorEventEmitter(claimed.input),
			);
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
					// wake was requested during this pass — but never once
					// shutdown has begun (its own wake() would otherwise
					// schedule one more pass).
				} while (!stopping && (progressed || wakeRequested));
			} catch (error) {
				// A transient DB error in listRunnableSubmissions or
				// claimSubmission should not kill the entire loop. Log,
				// back off briefly, and retry. Setting wakeRequested ensures
				// the loop retries immediately after the backoff instead of
				// sleeping indefinitely waiting for an external wake. During
				// shutdown, skip the backoff — the loop is about to exit and
				// `shutdown()` is awaiting it.
				console.error('[flue:claim-loop] Error in claim pass, retrying:', error);
				passEventEmitter(
					{
						type: 'submission_recovery',
						operation: 'reconcile_pass',
						outcome: 'deferred',
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
				);
				if (!stopping) {
					await new Promise<void>((r) => {
						const timer = setTimeout(r, 1000);
						if (typeof timer === 'object' && 'unref' in timer) timer.unref();
					});
				}
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
		claimLoopDone = claimLoop().catch((error) => {
			console.error('[flue:claim-loop] Fatal error in claim loop:', error);
			passEventEmitter(
				{
					type: 'submission_recovery',
					operation: 'reconcile_pass',
					outcome: 'deferred',
					error: serializeSubmissionError(error),
				},
				{ errorInfo: classifyError(error) },
			);
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
					passEventEmitter(
						{
							type: 'submission_recovery',
							operation: 'process_submission',
							outcome: 'deferred',
							error: serializeSubmissionError(error),
						},
						{ errorInfo: classifyError(error) },
					);
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
		await enforceActiveDeadlines();
		await reconcileRunningSubmissions();
	}

	/**
	 * How long past a deadline (durability timeout, or a durable abort
	 * intent) a live attempt task gets to unwind through its own settle path
	 * after its controller is aborted, before the scan force-settles the
	 * submission over it. Only a signal-deaf hang reaches the force path;
	 * mirrors the Cloudflare coordinator's grace.
	 */
	const SUBMISSION_SETTLE_GRACE_MS = 60_000;

	/**
	 * When each live attempt's controller was first fired by deadline
	 * enforcement, keyed by the controller so a replacement attempt starts
	 * its own clock.
	 */
	const attemptDeadlineSignaledAt = new WeakMap<AbortController, number>();

	/**
	 * Deadline enforcement over attempts that are live in this process. The
	 * lease heartbeat keeps renewing a hung attempt's lease — a live process
	 * looks identical to a working one — so the expired-lease reconcile pass
	 * can never reach it and `timeoutAt` would otherwise go unenforced for
	 * as long as the await hangs. Fire the attempt's controller at the
	 * deadline (signal-aware awaits unwind through processSubmission's own
	 * settle paths: timeout settles failed, abort intent settles aborted);
	 * past the grace — anchored to when the controller was first fired, so
	 * a late first scan never aborts and force-settles in the same breath —
	 * settle over the hung task via the shared interrupted path. Its late
	 * writes lose the settlement CAS and attempt-id fences.
	 */
	async function enforceActiveDeadlines(): Promise<void> {
		for (const [submissionId, active] of [...activeSubmissions]) {
			if (stopping) return;
			let submission: AgentSubmission | null;
			try {
				submission = await submissions.getSubmission(submissionId);
			} catch {
				continue;
			}
			if (submission?.status !== 'running') continue;
			const now = Date.now();
			const timedOut = submission.timeoutAt > 0 && now >= submission.timeoutAt;
			const abortRequested = submission.abortRequestedAt !== undefined;
			if (!timedOut && !abortRequested) continue;
			// Abort intent wins over timeout, mirroring the settle-order in
			// reconcileInterruptedSubmission. abort() is idempotent, so
			// re-signaling on every scan is safe.
			active.abort.abort(
				abortRequested ? new SubmissionAbortedError() : new SubmissionTimeoutError(),
			);
			// Abort intents were signaled at request time (abortInstance fires
			// the controller in-process), so they seed from abortRequestedAt.
			const signaledAt = attemptDeadlineSignaledAt.get(active.abort);
			const deadline =
				signaledAt ??
				(abortRequested && submission.abortRequestedAt !== undefined
					? Math.min(submission.abortRequestedAt, now)
					: now);
			if (signaledAt === undefined) attemptDeadlineSignaledAt.set(active.abort, deadline);
			if (now < deadline + SUBMISSION_SETTLE_GRACE_MS) {
				coordinatorEventEmitter(submission.input)({
					type: 'submission_recovery',
					submissionId: submission.submissionId,
					kind: submission.kind,
					operation: 'enforce_deadline',
					outcome: 'deferred',
					attemptCount: submission.attemptCount,
					maxAttempts: submission.maxAttempts,
					error: serializeSubmissionError(
						abortRequested ? new SubmissionAbortedError() : new SubmissionTimeoutError(),
					),
				});
				continue;
			}
			const agent = agents.find((record) => record.name === submission.input.agent)?.agent;
			if (!agent) continue;
			console.error('[flue:submission-reconciliation]', {
				submissionId: submission.submissionId,
				operation: 'enforce_deadline',
				outcome: 'terminated',
				reason: abortRequested ? 'abort_unhonored' : 'exceeded_timeout',
			});
			try {
				const conversationWriter = await getConversationWriter(submission.input);
				await reconcileInterruptedSubmission(
					submissions,
					submission,
					agent,
					makeSubmissionContext(submission.input, conversationWriter),
					{ ownerId, leaseExpiresAt: Date.now() + LEASE_DURATION_MS },
					conversationWriter,
					coordinatorEventEmitter(submission.input),
				);
				// Orphan the zombie: drop its active entry so idleness and the
				// claim loop key on the settled row (its own finally-cleanup is
				// unreachable), and rotate the cached conversation writer so
				// later sessions acquire a fresh producer — a waking zombie's
				// rejected append then fails only the stale writer object it
				// holds, never a successor's.
				activeSubmissions.delete(submissionId);
				conversationWriters.delete(agentStreamPath(submission.input.agent, submission.input.id));
			} catch (error) {
				coordinatorEventEmitter(submission.input)(
					{
						type: 'submission_recovery',
						submissionId: submission.submissionId,
						kind: submission.kind,
						operation: 'enforce_deadline',
						outcome: 'deferred',
						attemptCount: submission.attemptCount,
						maxAttempts: submission.maxAttempts,
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
				);
			}
		}
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
	 * independent fresh Sessions — the attempt-replacement CAS picks one
	 * winner, and the loser can append a spurious interruption advisory
	 * to session history before its settlement CAS is rejected.
	 */
	function reconcileRunningSubmissions(): Promise<void> {
		reconcilePassInFlight ??= runReconciliationPass().finally(() => {
			reconcilePassInFlight = null;
		});
		return reconcilePassInFlight;
	}

	/**
	 * Auto-fail a queued row whose materialization can never succeed, past its
	 * admission-anchored durability bound (see `unreadySubmissionDeadline`).
	 * Returns whether this coordinator won the terminal transition — a `false`
	 * (another coordinator settled first, or a racing pass made the row
	 * runnable) falls back to the deferral logging so nothing is silently
	 * dropped.
	 */
	async function terminalizeUnreadySubmission(
		submission: AgentSubmission,
		error: unknown,
	): Promise<boolean> {
		const settled = await settleUnclaimableSubmission(
			submissions,
			submission,
			'failed',
			error,
			coordinatorEventEmitter(submission.input),
		);
		if (!settled) return false;
		console.error(
			'[flue:submission-reconciliation]',
			{
				submissionId: submission.submissionId,
				operation: 'materialize_submission',
				outcome: 'terminated',
			},
			error,
		);
		return true;
	}

	async function reconcileUnreadySubmissions(): Promise<void> {
		for (const submission of await submissions.listUnreadySubmissions()) {
			// A durable abort on an unready row settles here: the row is never
			// claimable, so the attempt-based abort settle can never run — this is
			// the guaranteed escape hatch for every stuck-unready class.
			if (submission.abortRequestedAt !== undefined) {
				await settleUnclaimableSubmission(
					submissions,
					submission,
					'aborted',
					new SubmissionAbortedError(),
					coordinatorEventEmitter(submission.input),
				);
				continue;
			}
			const agent = agents.find((record) => record.name === submission.input.agent)?.agent;
			if (!agent) {
				if (
					Date.now() >= unreadySubmissionDeadline(submission, undefined) &&
					(await terminalizeUnreadySubmission(
						submission,
						new Error(
							`[flue] Submission target agent "${submission.input.agent}" has no registered definition, so the submission could never start.`,
						),
					))
				) {
					continue;
				}
				console.error('[flue:submission-reconciliation]', {
					submissionId: submission.submissionId,
					operation: 'materialize_submission',
					outcome: 'agent_unavailable',
				});
				coordinatorEventEmitter(submission.input)({
					type: 'submission_recovery',
					submissionId: submission.submissionId,
					kind: submission.kind,
					operation: 'materialize_submission',
					outcome: 'agent_unavailable',
				});
				continue;
			}
			try {
				await materializeSubmissionConversation(submission.input, agent);
				await submissions.markSubmissionCanonicalReady(submission.submissionId);
			} catch (error) {
				if (
					Date.now() >= unreadySubmissionDeadline(submission, agent) &&
					(await terminalizeUnreadySubmission(submission, error))
				) {
					continue;
				}
				console.error(
					'[flue:submission-reconciliation]',
					{
						submissionId: submission.submissionId,
						operation: 'materialize_submission',
						outcome: 'failed',
					},
					error,
				);
				coordinatorEventEmitter(submission.input)(
					{
						type: 'submission_recovery',
						submissionId: submission.submissionId,
						kind: submission.kind,
						operation: 'materialize_submission',
						outcome: 'deferred',
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
				);
			}
		}
	}

	async function runReconciliationPass(): Promise<void> {
		// Reconciling during shutdown would claim replacement attempts and
		// spawn tasks after the abort sweep, against a store the caller is
		// about to close; expired leases are next startup's recovery work.
		if (stopping) return;
		await reconcileUnreadySubmissions();
		for (const settlement of await submissions.listPendingSubmissionSettlements()) {
			try {
				const submission = await submissions.getSubmission(settlement.submissionId);
				if (!submission) continue;
				if (
					activeSubmissions.has(submission.submissionId) ||
					submission.leaseExpiresAt > Date.now()
				) {
					continue;
				}
				const writer = await getConversationWriter(submission.input);
				if (!writer) continue;
				await finalizePendingSettlement(
					submissions,
					writer,
					settlement,
					coordinatorEventEmitter(submission.input),
				);
			} catch (error) {
				console.error(
					'[flue:submission-reconciliation]',
					{
						submissionId: settlement.submissionId,
						operation: 'finalize_settlement',
						outcome: 'failed',
					},
					error,
				);
				passEventEmitter(
					{
						type: 'submission_recovery',
						submissionId: settlement.submissionId,
						operation: 'finalize_settlement',
						outcome: 'deferred',
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
				);
			}
		}
		for (const submission of await submissions.listExpiredSubmissions()) {
			// Shutdown began mid-pass: stop before claiming a replacement
			// attempt the abort sweep would never see.
			if (stopping) return;
			// Skip submissions still actively processing in this coordinator
			// (possible when heartbeat renewals fail transiently and the lease
			// expires while the task is mid-flight). Reconciling our own live
			// submission would spawn a second concurrent task for the same
			// session — exactly the corruption leases exist to prevent.
			if (activeSubmissions.has(submission.submissionId)) continue;
			const agentName = submission.input.agent;
			const agent = agents.find((record) => record.name === agentName)?.agent;
			if (!agent) {
				console.error('[flue:submission-reconciliation]', {
					submissionId: submission.submissionId,
					operation: 'reconcile_submission',
					outcome: 'agent_unavailable',
				});
				coordinatorEventEmitter(submission.input)({
					type: 'submission_recovery',
					submissionId: submission.submissionId,
					kind: submission.kind,
					operation: 'reconcile_submission',
					outcome: 'agent_unavailable',
					attemptCount: submission.attemptCount,
					maxAttempts: submission.maxAttempts,
				});
				continue;
			}
			try {
				const conversationWriter = await getConversationWriter(submission.input);
				const replacement = await reconcileInterruptedSubmission(
					submissions,
					submission,
					agent,
					makeSubmissionContext(submission.input, conversationWriter),
					{ ownerId, leaseExpiresAt: Date.now() + LEASE_DURATION_MS },
					conversationWriter,
					coordinatorEventEmitter(submission.input),
				);
				if (replacement) {
					spawnSubmissionTask(replacement);
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
				coordinatorEventEmitter(submission.input)(
					{
						type: 'submission_recovery',
						submissionId: submission.submissionId,
						kind: submission.kind,
						operation: 'reconcile_submission',
						outcome: 'deferred',
						attemptCount: submission.attemptCount,
						maxAttempts: submission.maxAttempts,
						error: serializeSubmissionError(error),
					},
					{ errorInfo: classifyError(error) },
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
			// Return once the pass has run — recovered and requeued work settles
			// in the background via the now-running claim loop. Callers that
			// boot an HTTP server (start(), `flue run`, the vite node servers)
			// await only this pass, so the server serves while recovery runs,
			// matching the Cloudflare coordinator. Callers that need completion
			// (shutdown, tests) await waitForIdle() explicitly.
		},

		async admitDispatch(input) {
			if (stopping) throw new RuntimeUnavailableError({ state: 'draining' });
			// The lease scopes the admission call itself — the gate is the
			// admission/request drain seam (pause() rejects new leases).
			// Background processing drains via waitForIdle()/shutdown(), never
			// the gate: leases keyed by submissionId leaked for joined
			// deliveries, rows still queued at shutdown, and settled replays.
			const activityLease = activityGate?.enter();
			try {
				const agent = agents.find((record) => record.name === input.agent)?.agent;
				if (!agent) {
					throw new Error(`[flue] dispatch target agent "${input.agent}" has no agent definition.`);
				}

				const submissionInput = createDispatchAgentSubmissionInput(input);
				const keyed = isKeyDerivedSubmissionId(input.submissionId);
				const loadReducedState = async () => {
					const writer = await getConversationWriter(submissionInput);
					return writer?.loadReducedState();
				};
				let contact: InstanceContactAdmission;
				try {
					contact = await admitInstanceContact({
						agent,
						id: input.id,
						initialData: input.initialData,
						uid: input.uid,
						loadReducedState,
					});
				} catch (error) {
					// Keyed retries can trip their own send condition (a create-only
					// send whose first attempt created the instance): adopt the
					// submission the key already names — the condition was consumed
					// by the original admission — and echo the recorded uid. A fresh
					// keyed send (no matching row) keeps today's exact semantics.
					if (keyed && isInstanceContactRejection(error)) {
						const adopted = await adoptKeyedSubmissionReplay(submissions, submissionInput);
						const uid = adopted ? (await loadReducedState())?.uid : undefined;
						if (adopted && uid !== undefined) {
							ensureClaimLoop();
							wake();
							return { kind: 'submission', submission: adopted, uid, deduplicated: true };
						}
					}
					throw error;
				}
				let admission = await submissions.admitDispatch(input);
				let deduplicated = false;
				if (admission.kind !== 'submission') {
					// The store's byte-exact compare rejects a caller retry (it
					// re-stamps acceptedAt); a keyed conflict converges on identity
					// instead. Unkeyed conflicts keep today's meaning: an internal
					// invariant violation the caller surfaces loudly.
					if (!keyed) return admission;
					const adopted = await adoptKeyedSubmissionReplay(submissions, submissionInput);
					if (!adopted) throw new SubmissionConflictError({ submissionId: input.submissionId });
					admission = { kind: 'submission', submission: adopted };
					deduplicated = true;
				}
				// Live queue signal, emitted immediately after durable admission.
				// At-least-once: admission cannot distinguish an idempotent
				// replay, so replays (keyed dedup included) re-emit.
				coordinatorEventEmitter(input)({
					type: 'submission_queued',
					submissionId: admission.submission.submissionId,
					kind: 'dispatch',
				});
				// The durable row exists from here on: the wake must fire even if
				// materialization/readiness/uid below throws, or the queued row
				// would strand with nothing to ever claim it.
				try {
					let submission = admission.submission;
					let identity: InstanceIdentity | undefined;
					if (submission.canonicalReadyAt === null) {
						identity = await materializeSubmissionConversation(submissionInput, agent);
						// Tolerate a null return (a concurrent readiness pass may have
						// advanced this row already): keep the admitted submission rather
						// than treat null as a lost submission.
						submission =
							(await submissions.markSubmissionCanonicalReady(submission.submissionId)) ??
							submission;
					}
					// The uid rides every receipt: echoed for a continuing send, minted
					// by materialization's identity ensure for a creating one. An
					// adopted replay may hold neither (its gate ran before the winning
					// admission materialized) — the birth record is durable by then,
					// so read the recorded identity back.
					let uid = contact.uid ?? identity?.uid;
					if (uid === undefined && deduplicated) uid = (await loadReducedState())?.uid;
					if (uid === undefined) {
						throw new Error(
							"[flue] invariant: a materialized instance's birth record must carry a uid.",
						);
					}

					return {
						kind: 'submission',
						submission,
						uid,
						...(deduplicated ? { deduplicated: true as const } : {}),
					};
				} finally {
					ensureClaimLoop();
					wake();
				}
			} finally {
				activityLease?.release();
			}
		},

		async abortInstance(agentName: string, instanceId: string): Promise<boolean> {
			// External submissions for an instance share one durable session, so
			// one session-scoped stamp covers the running head and every queued
			// submission behind it. The store is shared across agents: the key
			// carries the full (agent, id) address so another agent's instance
			// with the same id is untouched.
			const sessionKey = createSessionStorageKey(
				agentName,
				instanceId,
				SUBMISSION_HARNESS_NAME,
				SUBMISSION_SESSION_NAME,
			);
			const affected = await submissions.requestSessionAbort(sessionKey);
			if (affected.length === 0) return false;
			// Abort any of those attempts running in this process at a halt point —
			// processSubmission's catch settles them aborted. Queued ones settle via
			// the pre-execution abort check once claimed; a stranded running owner
			// is handled by reconciliation.
			let hasInactive = false;
			for (const submissionId of affected) {
				const active = activeSubmissions.get(submissionId);
				if (active) active.abort.abort(new SubmissionAbortedError());
				else hasInactive = true;
			}
			ensureClaimLoop();
			wake();
			if (hasInactive) {
				void reconcileRunningSubmissions().catch((error) => {
					console.error('[flue:submission-abort] reconcile after abort failed:', error);
					passEventEmitter(
						{
							type: 'submission_recovery',
							operation: 'reconcile_pass',
							outcome: 'deferred',
							error: serializeSubmissionError(error),
						},
						{ errorInfo: classifyError(error) },
					);
				});
			}
			return true;
		},

		createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission {
			return async (message: DeliveredMessage, options = {}) => {
				const { traceCarrier, initialData, uid, idempotencyKey } = options;
				if (stopping) throw new RuntimeUnavailableError({ state: 'draining' });
				// Same admission-scoped lease as admitDispatch: released when the
				// admission call returns, not when the submission settles.
				const activityLease = activityGate?.enter();
				try {
					const agent = agents.find((record) => record.name === agentName)?.agent;
					if (!agent) {
						throw new Error(
							`[flue] direct prompt target agent "${agentName}" has no agent definition.`,
						);
					}

					const input = await createDirectAgentSubmissionInput({
						agent: agentName,
						id: instanceId,
						message,
						initialData,
						traceCarrier,
						...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
					});
					const keyed = idempotencyKey !== undefined;
					const loadReducedState = async () => {
						const writer = await getConversationWriter(input);
						return writer?.loadReducedState();
					};
					// A deduplicated replay re-attaches from the stream origin: the
					// original admission-time offset is not persisted, and settlement
					// records are observable from the origin indefinitely.
					const adoptedReceipt = async (submissionId: string) => {
						const reducedUid = (await loadReducedState())?.uid;
						if (reducedUid === undefined) return undefined;
						ensureClaimLoop();
						wake();
						return {
							submissionId,
							offset: '-1',
							uid: reducedUid,
							deduplicated: true as const,
						};
					};
					let contact: InstanceContactAdmission;
					try {
						contact = await admitInstanceContact({
							agent,
							id: instanceId,
							initialData,
							uid,
							loadReducedState,
						});
					} catch (error) {
						// Keyed retries can trip their own send condition (see the
						// dispatch path): adopt the submission the key already names.
						if (keyed && isInstanceContactRejection(error)) {
							const adopted = await adoptKeyedSubmissionReplay(submissions, input);
							const receipt = adopted && (await adoptedReceipt(adopted.submissionId));
							if (receipt) return receipt;
						}
						throw error;
					}
					let admitted: AgentSubmission;
					let deduplicated = false;
					try {
						admitted = await submissions.admitDirect(input);
					} catch (error) {
						// The store rejects a caller retry byte-exactly (it re-stamps
						// acceptedAt/traceCarrier); a keyed admission converges on
						// identity above the store instead. Adoption only ever
						// swallows the failure when a matching-identity row exists.
						if (!keyed) throw error;
						const adopted = await adoptKeyedSubmissionReplay(submissions, input);
						if (!adopted) throw error;
						admitted = adopted;
						deduplicated = true;
					}
					// Live queue signal, emitted immediately after durable
					// admission. At-least-once: admission cannot distinguish an
					// idempotent replay, so replays (keyed dedup included) re-emit.
					coordinatorEventEmitter(input)({
						type: 'submission_queued',
						submissionId: admitted.submissionId,
						kind: 'direct',
					});
					// The durable row exists from here on: the wake must fire even if
					// materialization/readiness/uid below throws, or the queued row
					// would strand with nothing to ever claim it.
					try {
						let identity: InstanceIdentity | undefined;
						if (admitted.canonicalReadyAt === null) {
							identity = await materializeSubmissionConversation(input, agent);
							// Tolerate a null return: the claim loop's materialize-unready
							// pass races this admission and can mark-then-claim the row
							// first, so null means "already advanced past queued" — a
							// healthy row, not a lost submission (rows are never deleted).
							await submissions.markSubmissionCanonicalReady(input.submissionId);
						}
						const writer = await getConversationWriter(input);
						const offset = deduplicated ? '-1' : (writer?.offset ?? '-1');
						// An adopted replay may hold neither the contact uid nor a fresh
						// identity (its gate ran before the winning admission
						// materialized) — read the recorded identity back instead.
						let instanceUid = contact.uid ?? identity?.uid;
						if (instanceUid === undefined && deduplicated) {
							instanceUid = (await loadReducedState())?.uid;
						}
						if (instanceUid === undefined) {
							throw new Error(
								"[flue] invariant: a materialized instance's birth record must carry a uid.",
							);
						}
						return {
							submissionId: input.submissionId,
							offset,
							uid: instanceUid,
							...(deduplicated ? { deduplicated: true as const } : {}),
						};
					} finally {
						ensureClaimLoop();
						wake();
					}
				} finally {
					activityLease?.release();
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

			// Wake the claim loop so it exits (checks `stopping` flag), and
			// wait for it — plus any detached reconciliation pass (abort paths
			// fire them unawaited): once both have finished, no pass is
			// mid-flight against the stores and no new submission task can
			// spawn — so the abort sweep below is complete, and the caller may
			// close the persistence adapter the moment shutdown resolves.
			wake();
			if (claimLoopDone) await claimLoopDone;
			if (reconcilePassInFlight) await reconcilePassInFlight.catch(() => {});

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
				for (const submissionId of abandoned) {
					passEventEmitter({
						type: 'submission_recovery',
						submissionId,
						operation: 'process_submission',
						outcome: 'deferred',
					});
				}
			}

			// Close cached MCP connections last: settled submissions no longer
			// touch them, and any abandoned work above is being torn down anyway.
			const mcpCaches = [...mcpConnectionCaches.values()];
			mcpConnectionCaches.clear();
			await Promise.allSettled(mcpCaches.map((cache) => cache.close()));
		},
	};
}
