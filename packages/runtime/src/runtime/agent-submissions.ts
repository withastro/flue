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
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { type FlueTraceCarrier, interceptExecution } from '../execution-interceptor.ts';
import { getInternalSession } from '../session.ts';
import type {
	AgentDefinition,
	AttachedAgentEvent,
	CallHandle,
	DirectAgentPayload,
	PromptResponse,
} from '../types.ts';
import { type AttachmentStore, createAttachmentRef } from './attachment-store.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { agentStreamPath } from './event-stream-store.ts';
import { assertAgentDispatchAdmissionInput } from './handle-agent.ts';

export interface DispatchAgentSubmissionInput extends DispatchInput {
	readonly kind: 'dispatch';
	readonly submissionId: string;
	readonly traceCarrier?: FlueTraceCarrier;
}

export interface DirectAgentSubmissionInput {
	readonly kind: 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly payload: DirectAgentPayload;
	readonly acceptedAt: string;
	readonly traceCarrier?: FlueTraceCarrier;
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
	reconstructSubmissionResult(input: AgentSubmissionInput): Promise<PromptResponse | undefined> | PromptResponse | undefined;
	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<unknown>;
	recoverInterruptedStream(
		attempt: SubmissionAttemptRef,
		turnId?: string,
	): Promise<boolean>;
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
	readonly offset?: string;
	readonly result?: unknown;
}

export type AttachedAgentSubmissionAdmission = (
	payload: DirectAgentPayload,
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
	waitForResult?: boolean,
	traceCarrier?: FlueTraceCarrier,
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
	traceCarrier?: FlueTraceCarrier;
}): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: crypto.randomUUID(),
		agent: options.agent,
		id: options.id,
		payload: options.payload,
		acceptedAt: new Date().toISOString(),
		...(options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}),
	};
}

export async function materializeAgentSubmissionSession(
	ctx: FlueContextInternal,
	agent: AgentDefinition,
	input: AgentSubmissionInput,
	attachmentStore?: AttachmentStore,
): Promise<void> {
	if (input.kind === 'direct') ctx.setSubmissionId?.(input.submissionId);
	const session = await openAgentSubmissionSession(ctx, agent, input);
	if (input.kind === 'direct' && attachmentStore) {
		for (const [index, image] of (input.payload.images ?? []).entries()) {
			const bytes = decodeBase64(image.data);
			const attachment = await createAttachmentRef({
				id: `att_direct_${input.submissionId}_${index}`,
				mimeType: image.mimeType,
				bytes,
				...(image.filename ? { filename: image.filename } : {}),
			});
			const streamPath = agentStreamPath(input.agent, input.id);
			await attachmentStore.put({
				streamPath,
				attachment,
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
	conversationWriter?: ConversationRecordWriter,
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
	const inspected = (await createAgentSubmissionSessionHandler(agent, input, async (s) => {
		const state = await s.inspectSubmissionInput(input);
		return {
			state,
			result: state === 'completed' ? await s.reconstructSubmissionResult(input) : undefined,
		};
	})(ctx)) as { state: AgentSubmissionInspection; result: unknown };
	const state = inspected.state;
	if (state === 'completed') {
		if (submission.kind === 'direct') {
			await settleDirectSubmission(
				submissions,
				attempt,
				ctx,
				'completed',
				inspected.result,
				undefined,
				conversationWriter,
			);
		} else {
			await submissions.completeSubmission(attempt);
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
			undefined,
			conversationWriter,
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
			undefined,
			conversationWriter,
		);
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
				return { disposition: 'stale' };
			}
			return { disposition: 'replacement', submission: replacement };
		}
		return { disposition: 'stale' };
	}

	// Resumable progress, or the one accepted degraded window. Both the
	// durable-partial-stream case and the trailing-incomplete-tool-batch case
	// classify 'continuable'; 'uncertain' is the accepted provider-redispatch
	// window — nothing observable was persisted, so a single retry (which may
	// re-dispatch the provider once) is safe under the at-least-once execution
	// contract and `store: true` response replay.
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
		if (!replacement?.attemptId) return { disposition: 'stale' };
		if (state === 'continuable') {
			const recoveryCtx = createContext(dispatchId);
			if (submission.kind === 'direct') recoveryCtx.setSubmissionId?.(submission.submissionId);
			await createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.recoverInterruptedStream({
					submissionId: replacement.submissionId,
					attemptId: replacement.attemptId as string,
				}),
			)(recoveryCtx);
		}
		return { disposition: 'replacement', submission: replacement };
	}

	// Only 'absent' remains here (completed/continuable/uncertain handled
	// above; canonical input present without the marker is repaired above).
	if (submission.inputAppliedAt === undefined) {
		// Crashed before any canonical input was persisted — requeue for a
		// clean first attempt.
		await submissions.requeueSubmissionBeforeInputApplied(attempt);
		return { disposition: 'requeued' };
	}

	// The input-applied marker was written but the canonical input is absent
	// (it could not be persisted before the crash): nothing to resume — fail.
	const error = new SubmissionInterruptedError({ phase: 'after_input_application' });
	return failInterruptedSubmission(
		submissions,
		submission,
		attempt,
		agent,
		'interrupted_after_input_application',
		error,
		createContext,
		undefined,
		conversationWriter,
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
			console.error('[flue:submission-observer] interaction start callback failed:', error);
		}
	}

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
		let result: unknown;
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
			result = opts.wrapExecution ? await opts.wrapExecution(run) : await run();
		} catch (error) {
			if (opts.isShutdownAbort?.(error)) {
				if (submission.kind === 'direct') observers.fail(submission.submissionId, error);
				throw error;
			}
			const settled =
				submission.kind === 'direct'
					? await settleDirectSubmission(
							submissions,
							attempt,
							ctx,
							'failed',
							undefined,
							error,
							opts.conversationWriter,
						)
					: await submissions.failSubmission(attempt, error);
			if (submission.kind === 'direct' && settled) observers.fail(submission.submissionId, error);
			throw error;
		}
		const settled =
			submission.kind === 'direct'
				? await settleDirectSubmission(
						submissions,
						attempt,
						ctx,
						'completed',
						result,
						undefined,
						opts.conversationWriter,
					)
				: await submissions.completeSubmission(attempt);
		if (submission.kind === 'direct' && settled) observers.complete(submission.submissionId, result);
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
	interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>,
	conversationWriter?: ConversationRecordWriter,
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
	const settled =
		submission.kind === 'direct'
			? await settleDirectSubmission(
					submissions,
					attempt,
					ctx,
					'failed',
					undefined,
					error,
					conversationWriter,
				)
			: await submissions.failSubmission(attempt, error);
	if (!settled) return { disposition: 'stale' };
	return { disposition: 'failed', error };
}

async function settleDirectSubmission(
	submissions: AgentSubmissionStore,
	attempt: SubmissionAttemptRef,
	ctx: FlueContextInternal,
	outcome: 'completed' | 'failed',
	result?: unknown,
	error?: unknown,
	conversationWriter?: ConversationRecordWriter,
): Promise<boolean> {
	const event = ctx.createEvent({
		type: 'submission_settled',
		submissionId: attempt.submissionId,
		outcome,
		...(outcome === 'completed' ? { result } : { error: serializeSubmissionError(error) }),
	});
	if (!conversationWriter) return false;
	const eventKey = `record_direct-submission:${attempt.submissionId}:settled`;
	const reduced = await conversationWriter.loadReducedState();
	const conversation =
		[...reduced.conversations.values()].find((candidate) =>
			[...candidate.entries.values()].some((entry) => entry.submissionId === attempt.submissionId),
		) ??
		[...reduced.conversations.values()].find(
			(candidate) => candidate.harness === 'default' && candidate.session === 'default',
		);
	if (!conversation) return false;
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
			...(outcome === 'completed' ? { result } : { error: serializeSubmissionError(error) }),
		};
	const obligation =
		pending ??
		(await submissions.reserveSubmissionSettlement(attempt, {
			recordId: eventKey,
			record: settlement,
		}));
	if (!obligation) return false;
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
	ctx.publishEvent(event as AttachedAgentEvent);
	try {
		await ctx.flushEventCallbacks();
	} catch (callbackError) {
		console.error('[flue:subscriber] Terminal event subscriber failed:', callbackError);
	}
	return submissions.finalizeSubmissionSettlement(attempt, eventKey);
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
