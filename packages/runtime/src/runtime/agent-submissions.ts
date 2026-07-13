import { SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
} from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import type { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	FlueError,
	SubmissionAbortedError,
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { type FlueTraceCarrier, interceptExecution } from '../execution-interceptor.ts';
import { getInternalSession } from '../session.ts';
import type { AgentDefinition, CallHandle, DeliveredMessage } from '../types.ts';
import { type AttachmentStore, createAttachmentRef } from './attachment-store.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { agentStreamPath } from './event-stream-store.ts';

/**
 * One admitted agent submission — the persisted operational payload for both
 * transports. `kind` records how the submission arrived (`'dispatch'` via
 * `dispatch()`, `'direct'` via the agent HTTP route); a dispatch's
 * `submissionId` is the public `dispatchId` from its receipt.
 */
export interface AgentSubmissionInput {
	readonly kind: 'dispatch' | 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly message: DeliveredMessage;
	readonly acceptedAt: string;
	readonly traceCarrier?: FlueTraceCarrier;
}

export interface AgentSubmissionInterruption {
	readonly submissionId: string;
	readonly kind: AgentSubmissionInput['kind'];
	readonly reason:
		| 'interrupted_before_input_marker'
		| 'interrupted_after_input_application'
		| 'exhausted_retry_budget'
		| 'exceeded_timeout'
		| 'aborted';
	readonly message: string;
}

/** A tool call whose outcome could not be confirmed and was settled with an
 *  explicit interrupted-marker error at submission terminalization. */
export interface InterruptedToolCallRef {
	readonly name: string;
	readonly id: string;
}

export type AgentSubmissionInspection = 'absent' | 'completed' | 'continuable' | 'uncertain';



export interface ProcessAgentSubmissionOptions {
	submissionAttempt?: SubmissionAttemptRef;
	onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
	/** Claim timestamp used as the base for a newly resolved timeout. */
	startedAt?: number;
	/** Absolute timestamp (ms) after which the submission should be aborted. */
	timeoutAt?: number;
}

/**
 * Internal durable-submission executor surface that the submission
 * coordinators drive. `Session` declares conformance so signature drift is
 * caught at compile time.
 */
export interface AgentSubmissionSession {
	readonly conversationId: string;
	inspectSubmissionInput(input: AgentSubmissionInput): Promise<AgentSubmissionInspection> | AgentSubmissionInspection;
	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<void>;
	recoverInterruptedStream(
		attempt: SubmissionAttemptRef,
		turnId?: string,
	): Promise<boolean>;
	/**
	 * Record the terminal advisory for a failed/aborted submission. As the
	 * contract of terminalization, first settles the conversation to a
	 * deterministic rest state (ghost stream materialized, trailing tool batch
	 * marker-settled) and returns the calls that were settled with interrupted
	 * markers.
	 */
	recordSubmissionTerminal(
		input: AgentSubmissionInterruption,
	): Promise<ReadonlyArray<InterruptedToolCallRef>>;
}

interface AttachedAgentSubmissionReceipt {
	readonly submissionId: string;
	readonly offset: string;
}

export type AttachedAgentSubmissionAdmission = (
	message: DeliveredMessage,
	traceCarrier?: FlueTraceCarrier,
) => Promise<AttachedAgentSubmissionReceipt>;

export function createDispatchAgentSubmissionInput(input: DispatchInput): AgentSubmissionInput {
	return {
		kind: 'dispatch',
		submissionId: input.dispatchId,
		agent: input.agent,
		id: input.id,
		message: input.message,
		acceptedAt: input.acceptedAt,
	};
}

export function createDirectAgentSubmissionInput(options: {
	agent: string;
	id: string;
	message: DeliveredMessage;
	traceCarrier?: FlueTraceCarrier;
}): AgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: crypto.randomUUID(),
		agent: options.agent,
		id: options.id,
		message: options.message,
		acceptedAt: new Date().toISOString(),
		...(options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}),
	};
}

/**
 * Attachments are a property of the delivered message, not of the transport:
 * this materializes them for a `kind: 'user'` message regardless of whether
 * the submission arrived as a direct HTTP prompt or a `dispatch()` call.
 */
export async function materializeAgentSubmissionSession(
	ctx: FlueContextInternal,
	agent: AgentDefinition,
	input: AgentSubmissionInput,
	attachmentStore?: AttachmentStore,
): Promise<void> {
	if (input.kind === 'direct') ctx.setSubmissionId?.(input.submissionId);
	const session = await openAgentSubmissionSession(ctx, agent, input);
	const message = input.message;
	if (message.kind === 'user' && attachmentStore) {
		for (const [index, attachment] of (message.attachments ?? []).entries()) {
			const bytes = decodeBase64(attachment.data);
			const ref = await createAttachmentRef({
				id: `att_${input.kind}_${input.submissionId}_${index}`,
				mimeType: attachment.mimeType,
				bytes,
				...(attachment.filename ? { filename: attachment.filename } : {}),
			});
			const streamPath = agentStreamPath(input.agent, input.id);
			await attachmentStore.put({
				streamPath,
				attachment: ref,
				bytes,
				conversationId: session.conversationId,
			});
		}
	}
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

/** The public dispatch id for a dispatched submission (its `submissionId`), or `undefined` for a direct prompt. */
export function agentSubmissionDispatchId(input: AgentSubmissionInput): string | undefined {
	return input.kind === 'dispatch' ? input.submissionId : undefined;
}

/**
 * Shared reconciliation decision tree for an interrupted running submission.
 * Used by both the Cloudflare and Node agent coordinators.
 *
 * Returns the replacement submission when a new attempt was claimed and the
 * coordinator should start processing it. Returns `undefined` for every
 * other outcome (already completed, requeued, failed/terminalized, or stale)
 * because all durable side effects have already been applied inside this
 * function and the coordinator needs no further action.
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
	conversationWriter?: ConversationRecordWriter,
): Promise<AgentSubmission | undefined> {
	const { input } = submission;
	const attempt = submissionAttemptRef(submission);
	if (!attempt) return undefined;

	// Inspect canonical session state first: a completed canonical response
	// is finished provider work and settles as success unconditionally. The
	// retry budget and timeout below gate only the retry/replacement and
	// requeue branches — exhausting either must never discard (or append a
	// contradictory interruption advisory over) work that already completed.
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(dispatchId);
	if (submission.kind === 'direct') ctx.setSubmissionId?.(submission.submissionId);
	const state = await createAgentSubmissionSessionHandler(agent, input, (s) =>
		s.inspectSubmissionInput(input),
	)(ctx) as AgentSubmissionInspection;
	if (state === 'completed') {
		if (submission.kind === 'direct') {
			await settleDirectSubmission(
				submissions,
				attempt,
				ctx,
				'completed',
				undefined,
				conversationWriter,
			);
		} else {
			await submissions.completeSubmission(attempt);
		}
		return undefined;
	}

	// Abort requested before the owner could settle (it crashed, or the abort
	// never reached a halt point). Settle as the distinct aborted outcome rather
	// than retrying/resuming. Placed AFTER the completed-canonical check — a
	// finished response still settles as success — and BEFORE the
	// retry/timeout/resume branches so a crash-interrupted abort is never
	// resurrected and the attempt budget/timeout cannot pre-empt it.
	if (submission.abortRequestedAt !== undefined) {
		const abortCtx = createContext(dispatchId);
		if (submission.kind === 'direct') abortCtx.setSubmissionId?.(submission.submissionId);
		await settleAbortedWithContext(
			submissions,
			submission,
			attempt,
			agent,
			abortCtx,
			conversationWriter,
		);
		return undefined;
	}

	// Check retry budget. Pre-input exhaustion gets its own terminal error:
	// when the input was never applied, every attempt was consumed by a
	// claim/interruption cycle (crash, restart, or shutdown) before any
	// provider work started, so "exceeded maximum recovery attempts" would
	// misdescribe work that never happened. The shared budget itself is
	// intentional — only the message distinguishes the case.
	if (submission.attemptCount >= submission.maxRetry) {
		await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exhausted_retry_budget',
			(interruptedTools) =>
				submission.inputAppliedAt === undefined
					? new SubmissionInterruptedError({
							phase: 'retry_exhausted_before_input',
							attemptCount: submission.attemptCount,
							maxAttempts: submission.maxRetry,
						})
					: new SubmissionRetryExhaustedError({
							attemptCount: submission.attemptCount,
							maxAttempts: submission.maxRetry,
							...(interruptedTools ? { interruptedTools } : {}),
						}),
			createContext,
			conversationWriter,
		);
		return undefined;
	}

	// Check timeout.
	if (submission.timeoutAt > 0 && Date.now() >= submission.timeoutAt) {
		await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exceeded_timeout',
			() => new SubmissionTimeoutError(),
			createContext,
			conversationWriter,
		);
		return undefined;
	}

	// Canonical input exists but the operational input-applied marker did not
	// land (the crash window between persisting the input and writing the
	// marker). Re-acquire the attempt, mark the input applied, and let resume
	// processing classify and continue from the canonical input.
	if (submission.inputAppliedAt === undefined && state !== 'absent') {
		const replacement = await submissions.replaceSubmissionAttempt(
			attempt,
			crypto.randomUUID(),
			lease,
		);
		if (replacement?.attemptId) {
			const replacementAttempt = {
				submissionId: replacement.submissionId,
				attemptId: replacement.attemptId,
			};
			if (!(await submissions.markSubmissionInputApplied(replacementAttempt, {
				maxRetry: replacement.maxRetry,
				timeoutAt: replacement.timeoutAt,
			}))) {
				return undefined;
			}
			return replacement;
		}
		return undefined;
	}

	// Resumable progress, or the one accepted degraded window. Both the
	// durable-partial-stream case and the trailing-incomplete-tool-batch case
	// classify 'continuable'; 'uncertain' is the accepted provider-redispatch
	// window. In the input-only case, the assistant start may already be
	// persisted even though no output was produced, so recovery must terminalize
	// that in-progress message before the provider is re-dispatched. A single
	// retry is safe under the at-least-once execution contract and `store: true`
	// response replay.
	//
	// Acquire the replacement attempt (the fencing CAS) BEFORE any recovery
	// append, so a reconciler that loses the CAS never mutates session history.
	// Resume processing then classifies the canonical state and runs the right
	// continuation:
	//   - a durable partial stream is materialized here by
	//     `recoverInterruptedStream` (self-guards to a no-op when there is none);
	//   - an incomplete tool batch — partial OR zero-result — is repaired at
	//     resume by `repairTrailingPartialToolBatch`, which writes explicit
	//     unknown-outcome errors and NEVER re-executes a tool.
	//
	// TODO(multi-process): the terminal path (`failInterruptedSubmission`)
	// still appends the `submission_interrupted` advisory before the
	// `failSubmission` CAS, so a reconciler that loses that CAS has already
	// polluted session history. Safe today because Cloudflare DOs are
	// single-threaded and multi-process Node is not a supported configuration;
	// when it is, move `recordSubmissionTerminal` after (or condition it on)
	// the `failSubmission` CAS. The recovery-append ordering above no longer
	// has this hazard (the CAS now precedes the append).
	if (state === 'continuable' || state === 'uncertain') {
		const replacement = await submissions.replaceSubmissionAttempt(
			attempt,
			crypto.randomUUID(),
			lease,
		);
		if (!replacement?.attemptId) return undefined;
		if (state === 'continuable' || state === 'uncertain') {
			const recoveryCtx = createContext(dispatchId);
			if (submission.kind === 'direct') recoveryCtx.setSubmissionId?.(submission.submissionId);
			await createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.recoverInterruptedStream({
					submissionId: replacement.submissionId,
					attemptId: replacement.attemptId as string,
				}),
			)(recoveryCtx);
		}
		return replacement;
	}

	// Only 'absent' remains here (completed/continuable/uncertain handled
	// above; canonical input present without the marker is repaired above).
	if (submission.inputAppliedAt === undefined) {
		// Crashed before any canonical input was persisted — requeue for a
		// clean first attempt.
		await submissions.requeueSubmissionBeforeInputApplied(attempt);
		return undefined;
	}

	// The input-applied marker was written but the canonical input is absent
	// (it could not be persisted before the crash): nothing to resume — fail.
	await failInterruptedSubmission(
		submissions,
		submission,
		attempt,
		agent,
		'interrupted_after_input_application',
		(interruptedTools) =>
			new SubmissionInterruptedError({
				phase: 'after_input_application',
				...(interruptedTools ? { interruptedTools } : {}),
			}),
		createContext,
		conversationWriter,
	);
	return undefined;
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
	conversationWriter?: ConversationRecordWriter;
	onInteractionStart?: (interaction: {
		agentName: string;
		instanceId: string;
		kind: AgentSubmission['kind'];
		submissionId: string;
		dispatchId?: string;
	}) => void;
	/**
	 * Optional abort signal. When aborted, the session finishes the current
	 * turn and throws AbortError. Used by the Node coordinator for graceful
	 * shutdown.
	 */
	signal?: AbortSignal;
	/**
	 * Called when the signal is an AbortError and should be treated as a
	 * shutdown — the submission is not settled (stays in 'running'). Return
	 * `true` to suppress normal settlement.
	 */
	isShutdownAbort?: (error: unknown) => boolean;
	/**
	 * Called in the finally block after settlement. Used by the Cloudflare
	 * coordinator to trigger post-settlement reconciliation.
	 */
	onSettled?: () => void;
}

/**
 * Shared submission processing logic used by both Node and Cloudflare
 * coordinators. Validates the submission, creates a context, runs the agent
 * handler, and settles the submission on success or failure.
 */
export async function processSubmission(opts: ProcessSubmissionOptions): Promise<void> {
	const { submissions, submission } = opts;
	const { input } = submission;
	if (!submission.attemptId) return;
	const attempt: SubmissionAttemptRef = {
		submissionId: submission.submissionId,
		attemptId: submission.attemptId,
	};
	const persisted = await submissions.getSubmission(submission.submissionId);
	if (persisted?.status !== 'running' || persisted.attemptId !== attempt.attemptId) return;
	if (submission.attemptCount === 1 && opts.onInteractionStart) {
		try {
			opts.onInteractionStart({
				agentName: input.agent,
				instanceId: input.id,
				kind: submission.kind,
				submissionId: submission.submissionId,
				dispatchId: agentSubmissionDispatchId(input),
			});
		} catch (error) {
			console.error('[flue:submission-processing] interaction start callback failed:', error);
		}
	}

	const agent = opts.resolveAgent(input.agent);
	const ctx = opts.createContext(agentSubmissionDispatchId(input));

	if (submission.kind === 'direct') {
		ctx.setSubmissionId?.(submission.submissionId);
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
					if (submission.kind === 'direct') {
						try {
							await ctx.flushEventCallbacks();
						} catch (callbackError) {
							console.error(
								'[flue:event-stream] Direct user event persistence failed before provider execution:',
								callbackError,
							);
						}
					}
				},
				startedAt: submission.startedAt,
				timeoutAt:
					submission.inputAppliedAt !== undefined && submission.timeoutAt > 0
						? submission.timeoutAt
						: undefined,
				submissionAttempt: attempt,
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
		// Pre-execution abort: a queued submission that was abort-flagged is still
		// claimed (creating an attempt) so settlement is uniform and
		// attempt-based; settle it as aborted before running any model work. This
		// also covers an abort that landed between claim and processing.
		if (persisted.abortRequestedAt !== undefined) {
			await settleAbortedWithContext(
				submissions,
				submission,
				attempt,
				agent,
				ctx,
				opts.conversationWriter,
			);
			return;
		}
		try {
			const run = () =>
				interceptExecution(
					{
						type: 'agent',
						operationId: submission.submissionId,
						operationKind: 'prompt',
					},
					{
						instanceId: input.id,
						submissionId: submission.submissionId,
						dispatchId: agentSubmissionDispatchId(input),
						agentName: input.agent,
						traceCarrier: input.traceCarrier,
					},
					execute,
				);
			await run();
		} catch (error) {
			if (opts.isShutdownAbort?.(error)) {
				throw error;
			}
			// Abort: keyed on the coordinator signal's reason (robust even when the
			// provider rejects with a generic AbortError) rather than the thrown
			// error's shape. Settles the distinct aborted outcome instead of a
			// failure. Shutdown abort above intentionally takes precedence — the
			// submission stays running and recovery settles it aborted via the
			// durable abort flag.
			if (opts.signal?.reason instanceof SubmissionAbortedError) {
				await settleAbortedWithContext(
					submissions,
					submission,
					attempt,
					agent,
					ctx,
					opts.conversationWriter,
				);
				return;
			}
			if (submission.kind === 'direct') {
				await settleDirectSubmission(
					submissions,
					attempt,
					ctx,
					'failed',
					error,
					opts.conversationWriter,
				);
			} else {
				await submissions.failSubmission(attempt, error);
			}
			throw error;
		}
		if (submission.kind === 'direct') {
			await settleDirectSubmission(
				submissions,
				attempt,
				ctx,
				'completed',
				undefined,
				opts.conversationWriter,
			);
		} else {
			await submissions.completeSubmission(attempt);
		}
	} finally {
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
	createError: (interruptedTools?: ReadonlyArray<InterruptedToolCallRef>) => Error,
	createContext: (dispatchId: string | undefined) => FlueContextInternal,
	conversationWriter?: ConversationRecordWriter,
): Promise<void> {
	const { input } = submission;
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(dispatchId);
	if (submission.kind === 'direct') ctx.setSubmissionId?.(submission.submissionId);
	// The terminal record settles the conversation to a deterministic rest
	// state (ghost stream materialized, unresolved tool calls marker-settled)
	// and reports which calls were interrupted; the settlement error is then
	// built from that report so store waiters carry the same structured
	// metadata. Best-effort: if the record fails (e.g., disk full, SQLite
	// corruption), proceed to settle the submission anyway — a persistent save
	// failure must not leave the submission in an infinite reconciliation loop.
	let interruptedTools: ReadonlyArray<InterruptedToolCallRef> | undefined;
	try {
		interruptedTools = await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.recordSubmissionTerminal({
				submissionId: submission.submissionId,
				kind: submission.kind,
				reason,
				message: createError(undefined).message,
			}),
		)(ctx) as ReadonlyArray<InterruptedToolCallRef>;
	} catch (terminalError) {
		console.error(
			'[flue:submission-reconciliation] Failed to record terminal message for submission',
			submission.submissionId,
			terminalError,
		);
	}
	const error = createError(interruptedTools?.length ? interruptedTools : undefined);
	if (submission.kind === 'direct') {
		await settleDirectSubmission(
			submissions,
			attempt,
			ctx,
			'failed',
			error,
			conversationWriter,
		);
	} else {
		await submissions.failSubmission(attempt, error);
	}
}

/**
 * Settle a submission as the distinct `aborted` terminal outcome. Shared by the
 * pre-execution abort check, the in-flight abort catch, and the recovery abort
 * branch.
 *
 * Both kinds record a `submission_aborted` conversation advisory (best-effort —
 * a persistent save failure must not wedge settlement in a reconciliation loop)
 * so the abort is always visible in the message timeline. Direct submissions
 * additionally settle through the two-phase outbox with `outcome: 'aborted'`,
 * the durable terminal record a reconnecting waiter observes; dispatch
 * submissions settle the operational row with `failSubmission`.
 */
async function settleAbortedWithContext(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	attempt: SubmissionAttemptRef,
	agent: AgentDefinition,
	ctx: FlueContextInternal,
	conversationWriter?: ConversationRecordWriter,
): Promise<void> {
	const error = new SubmissionAbortedError();
	// Visible timeline advisory for both kinds.
	try {
		await createAgentSubmissionSessionHandler(agent, submission.input, (s) =>
			s.recordSubmissionTerminal({
				submissionId: submission.submissionId,
				kind: submission.kind,
				reason: 'aborted',
				message: error.message,
			}),
		)(ctx);
	} catch (advisoryError) {
		console.error(
			'[flue:submission-abort] Failed to record abort advisory for submission',
			submission.submissionId,
			advisoryError,
		);
	}
	if (submission.kind === 'direct') {
		await settleDirectSubmission(
			submissions,
			attempt,
			ctx,
			'aborted',
			error,
			conversationWriter,
		);
	} else {
		await submissions.failSubmission(attempt, error);
	}
}

async function settleDirectSubmission(
	submissions: AgentSubmissionStore,
	attempt: SubmissionAttemptRef,
	ctx: FlueContextInternal,
	outcome: 'completed' | 'failed' | 'aborted',
	error?: unknown,
	conversationWriter?: ConversationRecordWriter,
): Promise<void> {
	const event = ctx.createEvent({
		type: 'submission_settled',
		submissionId: attempt.submissionId,
		outcome,
		...(outcome === 'completed' ? {} : { error: serializeSubmissionError(error) }),
	});
	if (!conversationWriter) return;
	const eventKey = `record_direct-submission:${attempt.submissionId}:settled`;
	const reduced = await conversationWriter.loadReducedState();
	const conversation =
		[...reduced.conversations.values()].find((candidate) =>
			[...candidate.entries.values()].some((entry) => entry.submissionId === attempt.submissionId),
		) ??
		[...reduced.conversations.values()].find(
			(candidate) => candidate.harness === 'default' && candidate.session === 'default',
		);
	if (!conversation) return;
	const pending = (await submissions.listPendingSubmissionSettlements()).find(
		(candidate) => candidate.submissionId === attempt.submissionId,
	);
	const settlement =
		pending?.record ?? {
			v: 1 as const,
			id: eventKey,
			type: 'submission_settled' as const,
			conversationId: conversation.conversationId,
			harness: conversation.harness,
			session: conversation.session,
			timestamp: new Date().toISOString(),
			submissionId: attempt.submissionId,
			attemptId: attempt.attemptId,
			outcome,
			...(outcome === 'completed' ? {} : { error: serializeSubmissionError(error) }),
		};
	const obligation =
		pending ??
		(await submissions.reserveSubmissionSettlement(attempt, {
			recordId: eventKey,
			record: settlement,
		}));
	if (!obligation) return;
	const existing = await conversationWriter.getRecord(eventKey);
	if (!existing) {
		await conversationWriter.append([obligation.record], { submission: attempt });
	} else if (JSON.stringify(existing) !== JSON.stringify(obligation.record)) {
		// A canonical settlement record with this submission's deterministic key
		// already exists but its content differs from what this attempt computed.
		// Attempt fencing makes this unreachable in normal operation (a settled
		// submission is not re-processed); if it ever happens it is an invariant
		// violation. The durable canonical record is the client-visible authority,
		// so finalize the operational row against it rather than returning false —
		// refusing would wedge reconciliation in an unterminable loop. Surface it
		// loudly for diagnosis instead of swallowing it.
		console.error(
			'[flue:submission-settlement] Canonical settlement conflict; the existing durable record is authoritative.',
			{ submissionId: attempt.submissionId, recordId: eventKey },
		);
	}
	ctx.publishEvent(event);
	try {
		await ctx.flushEventCallbacks();
	} catch (callbackError) {
		console.error('[flue:subscriber] Terminal event subscriber failed:', callbackError);
	}
	await submissions.finalizeSubmissionSettlement(attempt, eventKey);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function serializeSubmissionError(error: unknown): {
	name?: string;
	message: string;
	type?: string;
	details?: string;
	dev?: string;
	meta?: Record<string, unknown>;
} {
	if (error instanceof FlueError) {
		return {
			name: error.name,
			message: error.message,
			type: error.type,
			details: error.details,
			...(error.meta ? { meta: error.meta } : {}),
		};
	}
	return {
		name: 'Error',
		message: 'The agent submission failed because of an internal error.',
		type: 'internal_error',
		details: 'The server encountered an unexpected error while processing the agent submission.',
	};
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
