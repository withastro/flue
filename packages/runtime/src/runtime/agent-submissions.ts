import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
} from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import type {
	AttachedAgentEvent,
	CreatedAgent,
	DirectAgentPayload,
} from '../types.ts';
import type { DispatchInput } from './dispatch-queue.ts';

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
}

export interface ProcessAgentSubmissionOptions {
	onInputApplied?: () => Promise<void> | void;
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

export interface AgentSubmissionToolRequest {
	readonly toolCalls: ReadonlyArray<{ type: 'toolCall'; id: string; name: string }>;
}

interface AgentSubmissionSession {
	inspectSubmissionInput?(input: AgentSubmissionInput): AgentSubmissionInspection;
	processSubmissionInput?(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): PromiseLike<unknown>;
	repairInterruptedToolCalls?(
		input: AgentSubmissionInput,
		toolRequest: AgentSubmissionToolRequest,
	): Promise<string | undefined>;
	recordSubmissionTerminal?(input: AgentSubmissionInterruption): Promise<void>;
}

type AgentSubmissionHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

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
) => Promise<unknown>;

export function createDispatchAgentSubmissionInput(input: DispatchInput): DispatchAgentSubmissionInput {
	return { ...input, kind: 'dispatch', submissionId: input.dispatchId };
}

export function createAgentSubmissionHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	options?: ProcessAgentSubmissionOptions,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.processSubmissionInput !== 'function') {
			throw new Error('[flue] Internal session does not support submission input processing.');
		}
		return session.processSubmissionInput(input, options);
	};
}

export function createAgentSubmissionInspectionHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.inspectSubmissionInput !== 'function') {
			throw new Error('[flue] Internal session does not support submission input inspection.');
		}
		return session.inspectSubmissionInput(input);
	};
}

export function createAgentSubmissionRepairHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	toolRequest: AgentSubmissionToolRequest,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.repairInterruptedToolCalls !== 'function') {
			throw new Error('[flue] Internal session does not support interrupted-tool repair.');
		}
		return session.repairInterruptedToolCalls(input, toolRequest);
	};
}

export function createAgentSubmissionTerminalHandler(
	agent: CreatedAgent,
	input: AgentSubmissionInput,
	terminal: AgentSubmissionInterruption,
): AgentSubmissionHandler {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		if (typeof session.recordSubmissionTerminal !== 'function') {
			throw new Error('[flue] Internal session does not support submission terminal persistence.');
		}
		await session.recordSubmissionTerminal(terminal);
	};
}

/** Payload for processing and terminal contexts: the user's direct payload or the dispatch input. */
export function agentSubmissionProcessingPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input.payload;
}

/** Payload for read-only contexts (inspection, repair): the full submission envelope. */
function agentSubmissionReadPayload(input: AgentSubmissionInput): unknown {
	return input.kind === 'dispatch' ? agentSubmissionDispatchInput(input) : input;
}

export function agentSubmissionDispatchId(input: AgentSubmissionInput): string | undefined {
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
			} catch {}
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
export function createSubmissionJournalCallbacks(
	submissions: Pick<
		import('../agent-execution-store.ts').AgentSubmissionStore,
		'beginTurnJournal' | 'updateTurnJournalPhase' | 'commitTurnJournal'
	>,
	submission: { submissionId: string; sessionKey: string; kind: 'dispatch' | 'direct' },
	attempt: import('../agent-execution-store.ts').SubmissionAttemptRef,
): NonNullable<ProcessAgentSubmissionOptions['journal']> {
	let journalTurnId: string | undefined;
	return {
		beforeProvider: (state) => {
			if (state.turnId !== journalTurnId) {
				journalTurnId = state.turnId;
				submissions.beginTurnJournal({
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
		providerStarted: (state) => {
			submissions.updateTurnJournalPhase(attempt, 'provider_started', {
				checkpointLeafId: state.checkpointLeafId,
			});
		},
		toolRequestRecorded: (state) => {
			submissions.updateTurnJournalPhase(attempt, 'tool_request_recorded', {
				checkpointLeafId: state.checkpointLeafId,
				toolRequest: state.toolRequest,
			});
		},
		checkpointReady: (state) => {
			submissions.updateTurnJournalPhase(attempt, 'before_provider', {
				checkpointLeafId: state.checkpointLeafId,
			});
		},
		committed: (state) => {
			submissions.commitTurnJournal(attempt, state.committedLeafId);
		},
	};
}

/**
 * Reconciliation result. `replacement` is the new submission to start when
 * a restart is needed. `failedError` is set when the submission was
 * terminalized — the caller can use it for observer notification.
 */
export interface ReconciliationResult {
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
			submissions, submission, attempt, agent, 'exhausted_retry_budget', error, createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Check timeout.
	if (submission.timeoutAt > 0 && Date.now() >= submission.timeoutAt) {
		const error = new Error('[flue] Agent submission exceeded configured timeout.');
		const failed = await failInterruptedSubmission(
			submissions, submission, attempt, agent, 'exceeded_timeout', error, createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Inspect canonical session state.
	const readPayload = agentSubmissionReadPayload(input);
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(readPayload, dispatchId);
	const state = await createAgentSubmissionInspectionHandler(agent, input)(ctx);

	// Check turn journal for pre-commit interruption that can be retried.
	const journal = submissions.getTurnJournal(submission.submissionId);
	if (
		journal &&
		(journal.phase === 'before_provider' || journal.phase === 'provider_started') &&
		!journal.committed &&
		state === 'continuable'
	) {
		const replacement = submissions.replaceTurnJournalAttempt(attempt, crypto.randomUUID());
		if (replacement) return { replacement, failedError: null };
	}

	// Check for interrupted tool calls that can be repaired.
	if (
		journal?.phase === 'tool_request_recorded' &&
		journal.committed === false &&
		journal.toolRequest
	) {
		const repairCtx = createContext(readPayload, dispatchId);
		const repairedLeafId = (await createAgentSubmissionRepairHandler(
			agent,
			input,
			journal.toolRequest as AgentSubmissionToolRequest,
		)(repairCtx)) as string | undefined;
		if (repairedLeafId) {
			submissions.updateTurnJournalPhase(attempt, 'before_provider', {
				checkpointLeafId: repairedLeafId,
			});
			const replacement = submissions.replaceTurnJournalAttempt(attempt, crypto.randomUUID());
			if (replacement) return { replacement, failedError: null };
		}
		if (state === 'continuable') {
			const replacement = submissions.replaceTurnJournalAttempt(attempt, crypto.randomUUID());
			if (replacement) return { replacement, failedError: null };
		}
	}

	// Pre-input-application interruption.
	if (submission.inputAppliedAt === undefined) {
		if (state === 'absent') {
			submissions.requeueSubmissionBeforeInputApplied(attempt);
			return { replacement: null, failedError: null };
		}
		const error = new Error(
			'[flue] Agent submission attempt was interrupted after canonical input persistence but before the input-application marker was recorded. Provider replay was not attempted.',
		);
		const failed = await failInterruptedSubmission(
			submissions, submission, attempt, agent,
			'interrupted_before_input_marker', error, createContext,
		);
		return { replacement: null, failedError: failed ? error : null };
	}

	// Post-input-application: check if the session already completed.
	if (state === 'completed') {
		submissions.completeSubmission(attempt);
		return { replacement: null, failedError: null };
	}

	// Collect interrupted tool metadata from the journal when available.
	const interruptedTools = journal?.toolRequest
		? (journal.toolRequest as AgentSubmissionToolRequest).toolCalls.map((tc) => ({ name: tc.name, id: tc.id }))
		: undefined;

	// Post-input-application interruption without completion.
	const error = new Error(
		interruptedTools
			? `[flue] Agent submission was interrupted with pending tool call(s): ${interruptedTools.map((t) => t.name).join(', ')}. The tool outcome could not be confirmed. The tool was not automatically retried.`
			: '[flue] Agent submission attempt was interrupted after input application without a completed canonical response. Provider replay was not attempted.',
	);
	const failed = await failInterruptedSubmission(
		submissions, submission, attempt, agent,
		'interrupted_after_input_application', error, createContext, interruptedTools,
	);
	return { replacement: null, failedError: failed ? error : null };
}

/** Synthetic dispatch request for reconciliation and Node dispatch contexts. */
export function submissionDispatchRequest(): Request {
	return new Request('https://flue.invalid/_dispatch', { method: 'POST' });
}

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
	await createAgentSubmissionTerminalHandler(agent, input, {
		submissionId: submission.submissionId,
		kind: submission.kind,
		reason,
		message: error.message,
		interruptedTools,
	})(ctx);
	return submissions.failSubmission(attempt, error);
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
	return session as AgentSubmissionSession;
}
