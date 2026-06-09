import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
} from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import type { AttachedAgentEvent, CallHandle, CreatedAgent, DirectAgentPayload } from '../types.ts';
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
	readonly session: string;
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

interface AgentSubmissionSession {
	inspectSubmissionInput(input: AgentSubmissionInput): AgentSubmissionInspection;
	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<unknown>;
	repairInterruptedToolCalls(
		input: AgentSubmissionInput,
		toolRequest: AgentSubmissionToolRequest,
	): Promise<string | undefined>;
	recoverInterruptedStream(streamKey: string): Promise<boolean>;
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

export type AttachedAgentSubmissionAdmission = (
	payload: DirectAgentPayload,
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
	waitForResult?: boolean,
) => Promise<unknown>;

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
		session: 'default',
		payload: options.payload,
		acceptedAt: new Date().toISOString(),
	};
}

export function createAgentSubmissionSessionHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	execute: (session: AgentSubmissionSession) => Promise<unknown> | unknown,
): (ctx: FlueContextInternal) => Promise<unknown> {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		return execute(session);
	};
}

/** Payload for processing and terminal contexts: the user's direct payload or the dispatch input. */
function agentSubmissionProcessingPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input.payload;
}

/** Payload for read-only contexts (inspection, repair): the full submission envelope. */
function agentSubmissionReadPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input;
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
 * Reconciliation result. `replacement` is the new submission to start when
 * a restart is needed. `failedError` is set when the submission was
 * terminalized — the caller can use it for observer notification.
 */
interface ReconciliationResult {
	readonly replacement: AgentSubmission | null;
	readonly failedError: Error | null;
}

/**
 * Shared reconciliation decision tree for an interrupted running submission.
 * Used by both the Cloudflare and Node agent coordinators.
 *
 * The `createContext` callback builds a `FlueContextInternal` for handler
 * execution. The shared function selects the appropriate payload internally
 * (read-only for inspection/repair, processing for terminal handlers).
 */
export async function reconcileInterruptedSubmission(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	agent: CreatedAgent,
	createContext: (payload: unknown, dispatchId: string | undefined) => FlueContextInternal,
	lease?: { ownerId: string; leaseExpiresAt: number },
): Promise<ReconciliationResult> {
	const { input } = submission;
	const attempt = submissionAttemptRef(submission);
	if (!attempt) return { replacement: null, failedError: null };

	// Check retry budget.
	if (submission.attemptCount >= submission.maxRetry) {
		const error = new Error(
			`[flue] Agent submission exceeded maximum recovery attempts (${submission.attemptCount}/${submission.maxRetry}).`,
		);
		const failed = await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exhausted_retry_budget',
			error,
			createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Check timeout.
	if (submission.timeoutAt > 0 && Date.now() >= submission.timeoutAt) {
		const error = new Error('[flue] Agent submission exceeded configured timeout.');
		const failed = await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exceeded_timeout',
			error,
			createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Inspect canonical session state.
	const readPayload = agentSubmissionReadPayload(input);
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(readPayload, dispatchId);
	const state = await createAgentSubmissionSessionHandler(agent, input, (s) =>
		s.inspectSubmissionInput(input),
	)(ctx);

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
	// repairInterruptedToolCalls does not. When multi-process is supported,
	// either move replaceTurnJournalAttempt before the mutations or add an
	// idempotency guard to repairInterruptedToolCalls. This is safe today
	// because Cloudflare DOs are single-threaded and multi-process Node is
	// not a supported configuration.
	const journal = await submissions.getTurnJournal(submission.submissionId);
	if (
		state !== 'completed' &&
		journal?.phase === 'provider_started' &&
		journal.committed === false &&
		journal.streamKey &&
		journal.streamConsumedAt === undefined
	) {
		const streamKey = journal.streamKey;
		const recoveryCtx = createContext(readPayload, dispatchId);
		const recovered = (await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.recoverInterruptedStream(streamKey),
		)(recoveryCtx)) as boolean;
		if (recovered) {
			await submissions.markStreamConsumed(attempt, journal.streamKey);
			await submissions.deleteStreamChunkSegments(journal.streamKey);
			const replacement = await submissions.replaceTurnJournalAttempt(
				attempt,
				crypto.randomUUID(),
				lease,
			);
			if (replacement) return { replacement, failedError: null };
		}
	}
	if (
		journal &&
		(journal.phase === 'before_provider' || journal.phase === 'provider_started') &&
		!journal.committed &&
		// 'continuable': session has partial progress that can resume.
		// 'uncertain' with before_provider: the provider hasn't started, so
		// a retry is safe — the journal is the authoritative record of what
		// happened, and it says we never reached the provider. Without this,
		// a crash after input application but before any provider response
		// would terminally fail the submission instead of retrying.
		(state === 'continuable' || (state === 'uncertain' && journal.phase === 'before_provider'))
	) {
		const replacement = await submissions.replaceTurnJournalAttempt(
			attempt,
			crypto.randomUUID(),
			lease,
		);
		if (replacement) return { replacement, failedError: null };
	}

	// Check for interrupted tool calls that can be repaired.
	if (
		journal?.phase === 'tool_request_recorded' &&
		journal.committed === false &&
		journal.toolRequest
	) {
		const repairCtx = createContext(readPayload, dispatchId);
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
			if (replacement) return { replacement, failedError: null };
		}
		if (state === 'continuable') {
			const replacement = await submissions.replaceTurnJournalAttempt(
				attempt,
				crypto.randomUUID(),
				lease,
			);
			if (replacement) return { replacement, failedError: null };
		}
	}

	// Pre-input-application interruption.
	if (submission.inputAppliedAt === undefined) {
		if (state === 'absent') {
			await submissions.requeueSubmissionBeforeInputApplied(attempt);
			return { replacement: null, failedError: null };
		}
		const error = new Error(
			'[flue] Agent submission attempt was interrupted after canonical input persistence but before the input-application marker was recorded. Provider replay was not attempted.',
		);
		const failed = await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'interrupted_before_input_marker',
			error,
			createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Post-input-application: check if the session already completed.
	if (state === 'completed') {
		await submissions.completeSubmission(attempt);
		return { replacement: null, failedError: null };
	}

	// Collect interrupted tool metadata from the journal when available.
	const interruptedTools = journal?.toolRequest
		? (journal.toolRequest as AgentSubmissionToolRequest).toolCalls.map((tc) => ({
				name: tc.name,
				id: tc.id,
			}))
		: undefined;

	// Post-input-application interruption without completion.
	const error = new Error(
		interruptedTools
			? `[flue] Agent submission was interrupted with pending tool call(s): ${interruptedTools.map((t) => t.name).join(', ')}. The tool outcome could not be confirmed. The tool was not automatically retried.`
			: '[flue] Agent submission attempt was interrupted after input application without a completed canonical response. Provider replay was not attempted.',
	);
	const failed = await failInterruptedSubmission(
		submissions,
		submission,
		attempt,
		agent,
		'interrupted_after_input_application',
		error,
		createContext,
		interruptedTools,
	);
	return { replacement: null, failedError: failed ? error : null };
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
		const attachedEvent = { ...event, instanceId } as AttachedAgentEvent & { runId?: string };
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
	/** Resolve a created agent by name. Must throw if absent. */
	resolveAgent: (name: string) => CreatedAgent;
	/** Build a context for this submission. */
	createContext: (payload: unknown, dispatchId: string | undefined) => FlueContextInternal;
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
	const ctx = opts.createContext(
		agentSubmissionProcessingPayload(input),
		agentSubmissionDispatchId(input),
	);

	if (submission.kind === 'direct') {
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
		const completed = await submissions.completeSubmission(attempt);
		if (completed && submission.kind === 'direct')
			observers.complete(submission.submissionId, result);
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
	agent: CreatedAgent,
	reason: AgentSubmissionInterruption['reason'],
	error: Error,
	createContext: (payload: unknown, dispatchId: string | undefined) => FlueContextInternal,
	interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>,
): Promise<boolean> {
	const { input } = submission;
	const processingPayload = agentSubmissionProcessingPayload(input);
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(processingPayload, dispatchId);
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
	return await submissions.failSubmission(attempt, error);
}

function submissionAttemptRef(submission: AgentSubmission): SubmissionAttemptRef | null {
	if (!submission.attemptId) return null;
	return { submissionId: submission.submissionId, attemptId: submission.attemptId };
}

async function openAgentSubmissionSession(
	ctx: FlueContextInternal,
	agent: CreatedAgent,
	input: AgentSubmissionInput,
): Promise<AgentSubmissionSession> {
	const harness = await ctx.initializeCreatedAgent(agent, undefined);
	const session = await harness.session(input.session);
	if (!session || typeof session !== 'object') {
		throw new Error('[flue] Internal session is unavailable for submission processing.');
	}
	return session as unknown as AgentSubmissionSession;
}
