import { SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
} from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import {
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { getInternalSession } from '../session.ts';
import type {
	AgentDefinition,
	AttachedAgentEvent,
	CallHandle,
	DirectAgentPayload,
	PromptResponse,
} from '../types.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { assertAgentDispatchAdmissionInput } from './handle-agent.ts';

export interface DispatchAgentSubmissionInput extends DispatchInput {
	readonly kind: 'dispatch';
	readonly submissionId: string;
}

export interface DirectAgentSubmissionInput {
	readonly kind: 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly payload: DirectAgentPayload;
	readonly acceptedAt: string;
}

export type AgentSubmissionInput = DispatchAgentSubmissionInput | DirectAgentSubmissionInput;

export interface AgentSubmissionInterruption {
	readonly submissionId: string;
	readonly kind: AgentSubmissionInput['kind'];
	readonly reason:
		| 'interrupted_before_input_marker'
		| 'interrupted_after_input_application'
		| 'exhausted_retry_budget'
		| 'exceeded_timeout';
	readonly message: string;
	/** Tool calls that were requested but whose outcomes could not be confirmed. */
	readonly interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>;
}

export type AgentSubmissionInspection = 'absent' | 'completed' | 'continuable' | 'uncertain';

interface ProcessAgentSubmissionJournalState {
	readonly operationId: string;
	readonly turnId: string;
	readonly checkpointLeafId?: string;
	readonly streamKey?: string;
}

export interface ProcessAgentSubmissionOptions {
	submissionAttempt?: SubmissionAttemptRef;
	onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
	/** Claim timestamp used as the base for a newly resolved timeout. */
	startedAt?: number;
	/** Absolute timestamp (ms) after which the submission should be aborted. */
	timeoutAt?: number;
	journal?: {
		beforeProvider?: (state: ProcessAgentSubmissionJournalState) => Promise<void> | void;
		providerStarted?: (state: ProcessAgentSubmissionJournalState) => Promise<void> | void;
		toolRequestRecorded?: (
			state: ProcessAgentSubmissionJournalState & { toolRequest: unknown },
		) => Promise<void> | void;
		checkpointReady?: (
			state: ProcessAgentSubmissionJournalState & { checkpointLeafId: string },
		) => Promise<void> | void;
		committed?: (
			state: ProcessAgentSubmissionJournalState & { committedLeafId: string },
		) => Promise<void> | void;
	};
}

interface AgentSubmissionToolRequest {
	readonly toolCalls: ReadonlyArray<{ type: 'toolCall'; id: string; name: string }>;
}

/**
 * Internal durable-submission executor surface that the submission
 * coordinators drive. `Session` declares conformance so signature drift is
 * caught at compile time.
 */
export interface AgentSubmissionSession {
	inspectSubmissionInput(input: AgentSubmissionInput): AgentSubmissionInspection;
	reconstructSubmissionResult(input: AgentSubmissionInput): PromptResponse | undefined;
	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<unknown>;
	repairInterruptedToolCalls(
		input: AgentSubmissionInput,
		toolRequest: AgentSubmissionToolRequest,
	): Promise<string | undefined>;
	recoverInterruptedStream(streamKey: string, turnCheckpointLeafId?: string): Promise<boolean>;
	recordSubmissionTerminal(input: AgentSubmissionInterruption): Promise<void>;
}

interface AgentSubmissionObserver {
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void;
}

interface AgentSubmissionAttachment {
	readonly completion: Promise<unknown>;
	detach(): void;
}

interface AgentSubmissionObserverRegistry {
	attach(submissionId: string, observer: AgentSubmissionObserver): AgentSubmissionAttachment;
	publish(submissionId: string, event: AttachedAgentEvent): Promise<void>;
	complete(submissionId: string, result: unknown): void;
	fail(submissionId: string, error: unknown): void;
}

interface AttachedAgentSubmissionReceipt {
	readonly submissionId: string;
	readonly result?: unknown;
}

export type AttachedAgentSubmissionAdmission = (
	payload: DirectAgentPayload,
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
	waitForResult?: boolean,
) => Promise<AttachedAgentSubmissionReceipt>;

export function createDispatchAgentSubmissionInput(
	input: DispatchInput,
): DispatchAgentSubmissionInput {
	return { ...input, kind: 'dispatch', submissionId: input.dispatchId };
}

export function createDirectAgentSubmissionInput(options: {
	agent: string;
	id: string;
	payload: DirectAgentPayload;
}): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: crypto.randomUUID(),
		agent: options.agent,
		id: options.id,
		payload: options.payload,
		acceptedAt: new Date().toISOString(),
	};
}

export function createAgentSubmissionSessionHandler(
	agent: AgentDefinition,
	input: AgentSubmissionInput,
	execute: (session: AgentSubmissionSession) => Promise<unknown> | unknown,
): (ctx: FlueContextInternal) => Promise<unknown> {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		return execute(session);
	};
}

function agentSubmissionDispatchId(input: AgentSubmissionInput): string | undefined {
	return input.kind === 'dispatch' ? input.dispatchId : undefined;
}

export function agentSubmissionDispatchInput(input: DispatchAgentSubmissionInput): DispatchInput {
	const { kind: _kind, submissionId: _submissionId, ...dispatch } = input;
	return dispatch;
}

export function createAgentSubmissionObserverRegistry(): AgentSubmissionObserverRegistry {
	const observers = new Map<
		string,
		AgentSubmissionObserver & { resolve(value: unknown): void; reject(error: unknown): void }
	>();
	return {
		attach(submissionId, observer) {
			if (observers.has(submissionId)) {
				throw new Error('[flue] Internal agent submission observer is already attached.');
			}
			let resolve!: (value: unknown) => void;
			let reject!: (error: unknown) => void;
			const completion = new Promise<unknown>((resolve_, reject_) => {
				resolve = resolve_;
				reject = reject_;
			});
			// Callers may never await completion (fire-and-forget admission, or
			// a failure before the await attaches) — keep a rejection from
			// surfacing as an unhandled-rejection crash.
			completion.catch(() => {});
			const attached = { ...observer, resolve, reject };
			observers.set(submissionId, attached);
			return {
				completion,
				detach() {
					if (observers.get(submissionId) === attached) observers.delete(submissionId);
				},
			};
		},
		async publish(submissionId, event) {
			try {
				await observers.get(submissionId)?.onEvent?.(event);
			} catch (error) {
				console.warn('[flue:submission-observer] onEvent callback failed:', error);
			}
		},
		complete(submissionId, result) {
			observers.get(submissionId)?.resolve(result);
			observers.delete(submissionId);
		},
		fail(submissionId, error) {
			observers.get(submissionId)?.reject(error);
			observers.delete(submissionId);
		},
	};
}

/**
 * Build the journal callback object for a submission attempt. Both the
 * Cloudflare coordinator and the Node dispatch processor use the same
 * journal phase lifecycle; this factory eliminates the duplication.
 */
function createSubmissionJournalCallbacks(
	submissions: Pick<
		AgentSubmissionStore,
		'beginTurnJournal' | 'updateTurnJournalPhase' | 'commitTurnJournal'
	>,
	submission: { submissionId: string; sessionKey: string; kind: 'dispatch' | 'direct' },
	attempt: SubmissionAttemptRef,
): NonNullable<ProcessAgentSubmissionOptions['journal']> {
	let journalTurnId: string | undefined;
	return {
		beforeProvider: async (state) => {
			if (state.turnId !== journalTurnId) {
				journalTurnId = state.turnId;
				await submissions.beginTurnJournal({
					submissionId: submission.submissionId,
					sessionKey: submission.sessionKey,
					kind: submission.kind,
					attemptId: attempt.attemptId,
					operationId: state.operationId,
					turnId: state.turnId,
					phase: 'before_provider',
					checkpointLeafId: state.checkpointLeafId,
				});
			}
		},
		providerStarted: async (state) => {
			await submissions.updateTurnJournalPhase(attempt, 'provider_started', {
				checkpointLeafId: state.checkpointLeafId,
				streamKey: state.streamKey,
			});
		},
		toolRequestRecorded: async (state) => {
			await submissions.updateTurnJournalPhase(attempt, 'tool_request_recorded', {
				checkpointLeafId: state.checkpointLeafId,
				toolRequest: state.toolRequest,
			});
		},
		checkpointReady: async (state) => {
			await submissions.updateTurnJournalPhase(attempt, 'before_provider', {
				checkpointLeafId: state.checkpointLeafId,
			});
		},
		committed: async (state) => {
			await submissions.commitTurnJournal(attempt, state.committedLeafId);
		},
	};
}

/**
 * Reconciliation disposition for an interrupted submission. Coordinators
 * use it for observer notification and replacement-attempt scheduling:
 *
 * - `replacement` — a new attempt was claimed; start processing it.
 * - `completed` — the canonical response had already completed; the
 *   submission settled as success and `result` carries the reconstructed
 *   response (or undefined when the session could not reproduce one).
 * - `requeued` — provably-unstarted work went back to the queue.
 * - `failed` — the submission was terminalized with `error`.
 * - `stale` — another attempt owns or already settled the submission;
 *   nothing for this caller to notify or start.
 */
type ReconciliationResult =
	| { readonly disposition: 'replacement'; readonly submission: AgentSubmission }
	| { readonly disposition: 'completed'; readonly result: unknown }
	| { readonly disposition: 'requeued' }
	| { readonly disposition: 'failed'; readonly error: Error }
	| { readonly disposition: 'stale' };

/**
 * Shared reconciliation decision tree for an interrupted running submission.
 * Used by both the Cloudflare and Node agent coordinators.
 *
 * The `createContext` callback builds a `FlueContextInternal` for handler
 * execution. Submission input is delivered through the session handler rather
 * than context construction.
 */
export async function reconcileInterruptedSubmission(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	agent: AgentDefinition,
	createContext: (dispatchId: string | undefined) => FlueContextInternal,
	lease?: { ownerId: string; leaseExpiresAt: number },
): Promise<ReconciliationResult> {
	const { input } = submission;
	const attempt = submissionAttemptRef(submission);
	if (!attempt) return { disposition: 'stale' };

	// Inspect canonical session state first: a completed canonical response
	// is finished provider work and settles as success unconditionally. The
	// retry budget and timeout below gate only the retry/replacement and
	// requeue branches — exhausting either must never discard (or append a
	// contradictory interruption advisory over) work that already completed.
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(dispatchId);
	if (submission.kind === 'direct') ctx.setSubmissionId?.(submission.submissionId);
	const inspected = (await createAgentSubmissionSessionHandler(agent, input, (s) => {
		const state = s.inspectSubmissionInput(input);
		return {
			state,
			result: state === 'completed' ? s.reconstructSubmissionResult(input) : undefined,
		};
	})(ctx)) as { state: AgentSubmissionInspection; result: unknown };
	const state = inspected.state;
	// Fetch the turn journal up front: every terminal settlement below must
	// also delete the journal's surviving chunk segments — the in-memory
	// staging set that would normally delete them at the next durable
	// checkpoint died with the interrupted process, and a settled submission
	// gets no later checkpoint.
	const journal = await submissions.getTurnJournal(submission.submissionId);
	if (state === 'completed') {
		// Settle as success and surface the persisted result. When the
		// settlement CAS is lost (another claimant settled first) the result
		// is still real — return it so a live observer resolves instead of
		// hanging; only the CAS winner emits the durable settlement event.
		const settled = await submissions.completeSubmission(attempt);
		if (settled) {
			emitSubmissionSettled(ctx, submission.submissionId, 'completed');
			if (journal?.streamKey) await submissions.deleteStreamChunkSegments(journal.streamKey);
		}
		return { disposition: 'completed', result: inspected.result };
	}

	// Check retry budget. Pre-input exhaustion gets its own terminal error:
	// when the input was never applied, every attempt was consumed by a
	// claim/interruption cycle (crash, restart, or shutdown) before any
	// provider work started, so "exceeded maximum recovery attempts" would
	// misdescribe work that never happened. The shared budget itself is
	// intentional — only the message distinguishes the case.
	if (submission.attemptCount >= submission.maxRetry) {
		const error =
			submission.inputAppliedAt === undefined
				? new SubmissionInterruptedError({
						phase: 'retry_exhausted_before_input',
						attemptCount: submission.attemptCount,
						maxAttempts: submission.maxRetry,
					})
				: new SubmissionRetryExhaustedError({
						attemptCount: submission.attemptCount,
						maxAttempts: submission.maxRetry,
					});
		return failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exhausted_retry_budget',
			error,
			createContext,
			journal?.streamKey,
		);
	}

	// Check timeout.
	if (submission.timeoutAt > 0 && Date.now() >= submission.timeoutAt) {
		const error = new SubmissionTimeoutError();
		return failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exceeded_timeout',
			error,
			createContext,
			journal?.streamKey,
		);
	}

	// Check turn journal for pre-commit interruption that can be retried.
	//
	// TODO(multi-process): The stream recovery and tool repair branches below
	// mutate session state (appending messages via recoverInterruptedStream /
	// repairInterruptedToolCalls) *before* calling replaceTurnJournalAttempt,
	// which is the atomic CAS that acquires ownership of the next attempt. In
	// a multi-process Node deployment sharing Postgres, two coordinators could
	// both observe the same expired-lease submission, both append recovery
	// messages, and then only one wins the CAS. recoverInterruptedStream has
	// a partial idempotency guard (alreadyRecovered check), but
	// repairInterruptedToolCalls does not. The same pattern exists on the
	// terminal path: failInterruptedSubmission appends the submission_interrupted
	// advisory (recordSubmissionTerminal) and saves the session *before* the
	// failSubmission CAS, so a reconciler that loses that CAS has already
	// polluted session history (its in-process findSubmissionTerminal guard
	// does not see a concurrent process's append). When multi-process is
	// supported, either move replaceTurnJournalAttempt before the mutations
	// or add an idempotency guard to repairInterruptedToolCalls, and move
	// recordSubmissionTerminal after (or make it conditional on) the
	// failSubmission CAS. This is safe today because Cloudflare DOs are
	// single-threaded and multi-process Node is not a supported configuration.
	if (
		journal?.phase === 'provider_started' &&
		journal.committed === false &&
		journal.streamKey &&
		journal.streamConsumedAt === undefined
	) {
		const streamKey = journal.streamKey;
		const turnCheckpointLeafId = journal.checkpointLeafId;
		const recoveryCtx = createContext(dispatchId);
		if (submission.kind === 'direct') recoveryCtx.setSubmissionId?.(submission.submissionId);
		const recovered = (await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.recoverInterruptedStream(streamKey, turnCheckpointLeafId),
		)(recoveryCtx)) as boolean;
		if (recovered) {
			await submissions.markStreamConsumed(attempt, journal.streamKey);
			await submissions.deleteStreamChunkSegments(journal.streamKey);
			const replacement = await submissions.replaceTurnJournalAttempt(
				attempt,
				crypto.randomUUID(),
				lease,
			);
			if (replacement) return { disposition: 'replacement', submission: replacement };
		}
	}
	// The journal is the authoritative record of provider work: a null
	// journal means no attempt ever reached the beforeProvider write (the
	// crash window between the input-application marker and the first
	// journal row), and phase 'before_provider' means the provider call for
	// the current turn never started. Either way a retry is safe by
	// construction.
	const providerUnreached = journal === null || journal.phase === 'before_provider';
	if (
		submission.inputAppliedAt !== undefined &&
		(journal === null ||
			((journal.phase === 'before_provider' || journal.phase === 'provider_started') &&
				!journal.committed)) &&
		// 'continuable': session has partial progress that restart processing
		// can resume (persisted tool results — repaired first at resume when
		// the recorded batch is incomplete, so completed calls are never
		// re-executed — a recovered stream partial, a transient retryable
		// error, or an aborted partial that replays from the last durable
		// message).
		// 'uncertain' with the provider unreached: nothing observable
		// happened, so a retry is safe. Without this, a crash after input
		// application but before any provider response would terminally fail
		// the submission instead of retrying.
		(state === 'continuable' || (state === 'uncertain' && providerUnreached))
	) {
		const replacement = await submissions.replaceTurnJournalAttempt(
			attempt,
			crypto.randomUUID(),
			lease,
		);
		if (replacement) return { disposition: 'replacement', submission: replacement };
	}

	// Check for interrupted tool calls that can be repaired.
	if (
		journal?.phase === 'tool_request_recorded' &&
		journal.committed === false &&
		journal.toolRequest
	) {
		const repairCtx = createContext(dispatchId);
		if (submission.kind === 'direct') repairCtx.setSubmissionId?.(submission.submissionId);
		const repairedLeafId = (await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.repairInterruptedToolCalls(input, journal.toolRequest as AgentSubmissionToolRequest),
		)(repairCtx)) as string | undefined;
		if (repairedLeafId) {
			await submissions.updateTurnJournalPhase(attempt, 'before_provider', {
				checkpointLeafId: repairedLeafId,
			});
			const replacement = await submissions.replaceTurnJournalAttempt(
				attempt,
				crypto.randomUUID(),
				lease,
			);
			if (replacement) return { disposition: 'replacement', submission: replacement };
		}
		if (state === 'continuable') {
			const replacement = await submissions.replaceTurnJournalAttempt(
				attempt,
				crypto.randomUUID(),
				lease,
			);
			if (replacement) return { disposition: 'replacement', submission: replacement };
		}
	}

	// Pre-input-application interruption.
	if (submission.inputAppliedAt === undefined) {
		if (state === 'absent') {
			await submissions.requeueSubmissionBeforeInputApplied(attempt);
			return { disposition: 'requeued' };
		}
		const error = new SubmissionInterruptedError({ phase: 'before_input_marker' });
		return failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'interrupted_before_input_marker',
			error,
			createContext,
			journal?.streamKey,
		);
	}

	// Collect interrupted tool metadata from the journal when available.
	const interruptedTools = journal?.toolRequest
		? (journal.toolRequest as AgentSubmissionToolRequest).toolCalls.map((tc) => ({
				name: tc.name,
				id: tc.id,
			}))
		: undefined;

	// Post-input-application interruption without completion.
	const error = new SubmissionInterruptedError({
		phase: 'after_input_application',
		interruptedTools,
	});
	return failInterruptedSubmission(
		submissions,
		submission,
		attempt,
		agent,
		'interrupted_after_input_application',
		error,
		createContext,
		journal?.streamKey,
		interruptedTools,
	);
}

/**
 * Create the event callback that forwards submission events to attached
 * observers. Filters `run_start`/`run_end`, strips `runId`, and sets
 * `instanceId`. Used by both Node and Cloudflare coordinators for direct
 * submissions.
 */
function createSubmissionEventCallback(
	submissionId: string,
	instanceId: string,
	publish: (submissionId: string, event: AttachedAgentEvent) => Promise<void>,
): (event: Record<string, unknown>) => Promise<void> | void {
	return (event) => {
		if (event.type === 'run_start' || event.type === 'run_end') return;
		const attachedEvent = { ...event, instanceId, submissionId } as AttachedAgentEvent & {
			runId?: string;
		};
		delete attachedEvent.runId;
		return publish(submissionId, attachedEvent);
	};
}

/** Synthetic request for the submission's kind: an agent route for direct prompts, the dispatch path for dispatches. */
export function submissionSyntheticRequest(input: AgentSubmissionInput): Request {
	if (input.kind === 'direct') {
		return new Request(
			`https://flue.invalid/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(input.id)}`,
			{ method: 'POST' },
		);
	}
	return new Request('https://flue.invalid/_dispatch', { method: 'POST' });
}

// ─── Shared submission processing ────────────────────────────────────────────

export interface ProcessSubmissionOptions {
	/** The submission store for state queries and settlement. */
	submissions: AgentSubmissionStore;
	/** The claimed submission to process. */
	submission: AgentSubmission;
	/** Resolve an agent definition by name. Must throw if absent. */
	resolveAgent: (name: string) => AgentDefinition;
	/** Build a context for this submission. */
	createContext: (dispatchId: string | undefined) => FlueContextInternal;
	/** Observer registry for direct submission events and settlement. */
	observers: Pick<AgentSubmissionObserverRegistry, 'publish' | 'complete' | 'fail'>;
	/**
	 * Optional abort signal. When aborted, the session finishes the current
	 * turn and throws AbortError. Used by the Node coordinator for graceful
	 * shutdown.
	 */
	signal?: AbortSignal;
	/**
	 * Called when the signal is an AbortError and should be treated as a
	 * shutdown — the submission is not settled (stays in 'running'), only the
	 * observer is notified. Return `true` to suppress normal settlement.
	 */
	isShutdownAbort?: (error: unknown) => boolean;
	/**
	 * Optional wrapper around the execution call. Used by the Cloudflare
	 * coordinator to run within `runWithInstanceContext`.
	 */
	wrapExecution?: <T>(fn: () => Promise<T>) => Promise<T>;
	/**
	 * Called in the finally block after settlement. Used by the Cloudflare
	 * coordinator to trigger post-settlement reconciliation.
	 */
	onSettled?: () => void;
}

/**
 * Shared submission processing logic used by both Node and Cloudflare
 * coordinators. Validates the submission, creates a context, wires event
 * forwarding for direct submissions, runs the agent handler, and settles
 * the submission on success or failure.
 */
export async function processSubmission(opts: ProcessSubmissionOptions): Promise<void> {
	const { submissions, submission, observers } = opts;
	const { input } = submission;
	if (!submission.attemptId) return;
	if (input.kind === 'dispatch') assertAgentDispatchAdmissionInput(input);
	const attempt: SubmissionAttemptRef = {
		submissionId: submission.submissionId,
		attemptId: submission.attemptId,
	};
	const persisted = await submissions.getSubmission(submission.submissionId);
	if (persisted?.status !== 'running' || persisted.attemptId !== attempt.attemptId) return;

	const agent = opts.resolveAgent(input.agent);
	const ctx = opts.createContext(agentSubmissionDispatchId(input));

	if (submission.kind === 'direct') {
		ctx.setSubmissionId?.(submission.submissionId);
		ctx.setEventCallback(
			createSubmissionEventCallback(submission.submissionId, input.id, (sid, event) =>
				observers.publish(sid, event),
			),
		);
	}

	const execute = () =>
		createAgentSubmissionSessionHandler(agent, input, (session) => {
			const handle = session.processSubmissionInput(input, {
				onInputApplied: async (durability: SubmissionDurability) => {
					if (!(await submissions.markSubmissionInputApplied(attempt, durability))) {
						throw new Error(
							'[flue] Agent submission attempt lost ownership before input application.',
						);
					}
				},
				startedAt: submission.startedAt,
				timeoutAt:
					submission.inputAppliedAt !== undefined && submission.timeoutAt > 0
						? submission.timeoutAt
						: undefined,
				submissionAttempt: attempt,
				journal: createSubmissionJournalCallbacks(submissions, submission, attempt),
			});
			// Wire the coordinator's abort signal so shutdown can cancel
			// in-flight work at the turn boundary.
			if (opts.signal && !opts.signal.aborted) {
				const signal = opts.signal;
				const onAbort = () => handle.abort(signal.reason);
				signal.addEventListener('abort', onAbort, { once: true });
				handle.then(
					() => signal.removeEventListener('abort', onAbort),
					() => signal.removeEventListener('abort', onAbort),
				);
			} else if (opts.signal?.aborted) {
				handle.abort(opts.signal.reason);
			}
			return handle;
		})(ctx);

	try {
		const result = opts.wrapExecution ? await opts.wrapExecution(execute) : await execute();
		await submissions.completeSubmission(attempt);
		// Always notify the observer for direct submissions so the caller's
		// completion promise resolves. When completeSubmission returns false
		// (stale attempt, superseded by another claimant), the result is
		// still the real response for this input — mirroring the fail path
		// below, an unnotified observer would otherwise hang forever.
		if (submission.kind === 'direct') observers.complete(submission.submissionId, result);
	} catch (error) {
		// During shutdown, the coordinator aborts active submissions at the
		// turn boundary. Don't permanently settle the submission — leave it
		// in 'running' so its expired lease triggers reclamation on restart.
		// Still notify the observer so the direct prompt caller's completion
		// promise rejects instead of hanging.
		if (opts.isShutdownAbort?.(error)) {
			if (submission.kind === 'direct') observers.fail(submission.submissionId, error);
			throw error;
		}
		await submissions.failSubmission(attempt, error);
		// Always notify the observer for direct submissions so the caller's
		// completion promise rejects. When failSubmission returns false
		// (stale attempt, superseded by another coordinator), the observer
		// would otherwise hang forever.
		if (submission.kind === 'direct') observers.fail(submission.submissionId, error);
		throw error;
	} finally {
		if (submission.kind === 'direct') ctx.setEventCallback(undefined);
		opts.onSettled?.();
	}
}

// ─── Reconciliation internals ────────────────────────────────────────────────

async function failInterruptedSubmission(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	attempt: SubmissionAttemptRef,
	agent: AgentDefinition,
	reason: AgentSubmissionInterruption['reason'],
	error: Error,
	createContext: (dispatchId: string | undefined) => FlueContextInternal,
	journalStreamKey: string | undefined,
	interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>,
): Promise<ReconciliationResult> {
	const { input } = submission;
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(dispatchId);
	if (submission.kind === 'direct') ctx.setSubmissionId?.(submission.submissionId);
	// The terminal message is a best-effort diagnostic recorded in the
	// session. If it fails (e.g., disk full, SQLite corruption), proceed
	// to settle the submission anyway — a persistent save failure must
	// not leave the submission in an infinite reconciliation loop.
	try {
		await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.recordSubmissionTerminal({
				submissionId: submission.submissionId,
				kind: submission.kind,
				reason,
				message: error.message,
				interruptedTools,
			}),
		)(ctx);
	} catch (terminalError) {
		console.error(
			'[flue:submission-reconciliation] Failed to record terminal message for submission',
			submission.submissionId,
			terminalError,
		);
	}
	const settled = await submissions.failSubmission(attempt, error);
	if (!settled) return { disposition: 'stale' };
	emitSubmissionSettled(ctx, submission.submissionId, 'failed', error);
	// Terminal settlement supersedes any chunk segments an interrupted turn
	// left durable for recovery; no later checkpoint will delete them. Only
	// the settlement CAS winner deletes — a lost CAS means another live
	// attempt may still need the segments.
	if (journalStreamKey) await submissions.deleteStreamChunkSegments(journalStreamKey);
	return { disposition: 'failed', error };
}

/**
 * Durable settlement marker for reconciliation-driven outcomes. Normal
 * processing leaves its own event trail; reconciliation settles work whose
 * original process is gone, so detached stream readers would otherwise never
 * learn the outcome. Best-effort: durable persistence rides the stream
 * subscription the coordinator wired onto the context, and a delivery
 * failure must never affect settlement itself.
 */
function emitSubmissionSettled(
	ctx: FlueContextInternal,
	submissionId: string,
	outcome: 'completed' | 'failed',
	error?: Error,
): void {
	try {
		ctx.emitEvent({
			type: 'submission_settled',
			submissionId,
			outcome,
			...(error ? { error: error.message } : {}),
		});
	} catch (emitError) {
		console.warn(
			'[flue:submission-reconciliation] Failed to emit settlement event for submission',
			submissionId,
			emitError,
		);
	}
}

function submissionAttemptRef(submission: AgentSubmission): SubmissionAttemptRef | null {
	if (!submission.attemptId) return null;
	return { submissionId: submission.submissionId, attemptId: submission.attemptId };
}

async function openAgentSubmissionSession(
	ctx: FlueContextInternal,
	agent: AgentDefinition,
	_input: AgentSubmissionInput,
): Promise<AgentSubmissionSession> {
	const harness = await ctx.initializeRootHarness(agent);
	// External submissions always target the default session of the default
	// harness. `harness.session()` hands out the public FlueSession facade;
	// unwrap it to reach the internal durable submission executor surface.
	// Non-facade objects (test fakes injected through this seam) are used
	// directly via the same structural contract.
	const session = await harness.session(SUBMISSION_SESSION_NAME);
	return getInternalSession(session) ?? (session as unknown as AgentSubmissionSession);
}
