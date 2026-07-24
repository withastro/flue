import * as v from 'valibot';
import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type {
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionDurability,
	SubmissionSettlementObligation,
} from '../agent-execution-store.ts';
import { decodeBase64 } from '../base64.ts';
import type { FlueContextInternal } from '../client.ts';
import type { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	classifyError,
	FlueError,
	InvalidRequestError,
	SubmissionAbortedError,
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { type FlueTraceCarrier, interceptExecution } from '../execution-interceptor.ts';
import { getInternalSession } from '../session.ts';
import type { Agent, CallHandle, DeliveredMessage } from '../types.ts';
import { type AttachmentStore, createAttachmentRef } from './attachment-store.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import {
	createConversationIdentity,
	generateAttemptId,
	generateInstanceUid,
	generateSubmissionId,
} from './ids.ts';
import { resolveAgentInitialDataSchema } from './registration.ts';
import { agentStreamPath } from './stream-offsets.ts';

/**
 * One admitted agent submission — the persisted operational payload for both
 * transports. `kind` records how the submission arrived (`'dispatch'` via
 * `dispatch()`, `'direct'` via the agent HTTP route); a dispatch's
 * `submissionId` is the one on its `DispatchReceipt`.
 */
export interface AgentSubmissionInput {
	readonly kind: 'dispatch' | 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly message: DeliveredMessage;
	/**
	 * Instance-creation data riding this submission. Consulted only when the
	 * submission turns out to be the instance's first contact; ignored on
	 * existing instances.
	 */
	readonly initialData?: unknown;
	readonly acceptedAt: string;
	readonly traceCarrier?: FlueTraceCarrier;
}

export interface AgentSubmissionInterruption {
	readonly submissionId: string;
	readonly kind: AgentSubmissionInput['kind'];
	readonly reason: 'exhausted_retry_budget' | 'exceeded_timeout' | 'aborted';
	readonly message: string;
}

/** A tool call whose outcome could not be confirmed and was settled with an
 *  explicit interrupted-marker error at submission terminalization. */
export interface InterruptedToolCallRef {
	readonly name: string;
	readonly id: string;
}

export type AgentSubmissionInspection = 'absent' | 'completed' | 'interrupted';

export interface ProcessAgentSubmissionOptions {
	submissionAttempt?: SubmissionAttemptRef;
	onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
	/** Claim timestamp used as the base for a newly resolved timeout. */
	startedAt?: number;
	/** Absolute timestamp (ms) after which the submission should be aborted. */
	timeoutAt?: number;
	/**
	 * Turn-boundary join seam (dispatch-while-busy): the session polls this
	 * at response start, every turn boundary, and the would-stop seam to
	 * absorb queued dispatch deliveries into the live response. Absent in
	 * degenerate/test setups — the session then serializes exactly as before.
	 */
	joinSource?: SubmissionJoinSource;
}

/**
 * The session-facing surface of the join protocol, bound to one host
 * attempt by the coordinator (`processSubmission`). Every method is fenced
 * on the host still running under that attempt, so a zombie session that
 * lost its claim can neither steal deliveries nor corrupt their state.
 */
export interface SubmissionJoinSource {
	/** Claim the joinable queued prefix (`queued → joining`), admission order. */
	claim(): Promise<AgentSubmission[]>;
	/** Confirm a join once its canonical input record is durable (`joining → joined`). */
	finalize(submissionId: string): Promise<boolean>;
	/** Hand an unapplied join back to the queue (`joining → queued`). */
	revert(submissionId: string): Promise<boolean>;
	/** Unsettled joins attached to the host (`joining` and `joined`), admission order. */
	listUnresolved(): Promise<AgentSubmission[]>;
}

/**
 * Internal durable-submission executor surface that the submission
 * coordinators drive. `Session` declares conformance so signature drift is
 * caught at compile time.
 */
export interface AgentSubmissionSession {
	readonly conversationId: string;
	inspectSubmissionInput(
		input: AgentSubmissionInput,
	): Promise<AgentSubmissionInspection> | AgentSubmissionInspection;
	processSubmissionInput(
		input: AgentSubmissionInput,
		options?: ProcessAgentSubmissionOptions,
	): CallHandle<void>;
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
	/** The instance uid: minted when this submission created, echoed when it continued. */
	readonly uid: string;
}

/** Options accompanying one attached (direct) submission admission. */
export interface AttachedAgentSubmissionOptions {
	/** Distributed-trace continuation extracted from the caller's context. */
	readonly traceCarrier?: FlueTraceCarrier;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	readonly initialData?: unknown;
	/**
	 * Send condition (uid ≈ ETag): a string continues only the incarnation
	 * with that uid; `null` creates only when no instance exists; omit to
	 * send unconditionally.
	 */
	readonly uid?: string | null;
}

export type AttachedAgentSubmissionAdmission = (
	message: DeliveredMessage,
	options?: AttachedAgentSubmissionOptions,
) => Promise<AttachedAgentSubmissionReceipt>;

/** Resolution of one send's admission against the instance's current state. */
export interface InstanceContactAdmission {
	/**
	 * The existing instance's uid when the send continues one. Undefined for
	 * creating sends (materialization's {@link ensureInstanceIdentity} mints
	 * and returns it for the receipt) and storeless admissions.
	 */
	readonly uid: string | undefined;
}

/**
 * Admission-side gate for one send's contact with an instance — sends are
 * CONDITIONAL requests (the uid plays the ETag):
 *
 * - no condition: unconditional deliver — continues an existing instance or
 *   creates a fresh one; `initialData` is the seed, consulted only when creating.
 * - `uid: '<value>'`: continue only the incarnation the caller knows —
 *   absent instance or mismatched uid throws {@link AgentInstanceNotFoundError}.
 *   Combining with `initialData` is a contradiction (the condition forbids
 *   creation, so a seed is dead weight) and throws.
 * - `uid: null`: create only when fresh — an existing instance throws
 *   {@link AgentInstanceExistsError} with the existing uid in its details.
 *
 * Creating sends additionally validate `initialData` against the agent's
 * `initialData` contract static (when declared). Everything here runs synchronously BEFORE anything
 * durable is admitted, so a failed condition or invalid creation leaves no
 * queued submission behind. The uid itself is minted by
 * {@link ensureInstanceIdentity} during admission-side materialization — never
 * here, and never carried on the durable submission payload — so dispatch
 * replays remain idempotent: a replayed admission finds the recorded identity.
 */
export async function admitInstanceContact(options: {
	agent: Agent;
	id: string;
	initialData: unknown;
	uid: string | null | undefined;
	loadReducedState: () => Promise<{ initialData?: { value: unknown }; uid?: string } | undefined>;
}): Promise<InstanceContactAdmission> {
	const condition = options.uid;
	if (typeof condition === 'string' && options.initialData !== undefined) {
		throw new InvalidRequestError({
			reason:
				'A send conditioned on an existing instance (`uid`) cannot carry `initialData` — the condition forbids creation, so the seed could never apply.',
		});
	}
	const reduced = await options.loadReducedState();
	if (!reduced) {
		// No conversation store to consult (degenerate/storeless configs).
		// Conditions cannot be verified; refuse them rather than guess.
		if (condition !== undefined) {
			throw new InvalidRequestError({
				reason:
					'Conditional sends (`uid`) require the runtime conversation store, which is unavailable here. Send without a uid condition.',
			});
		}
		return { uid: undefined };
	}
	const exists = reduced.initialData !== undefined;
	if (typeof condition === 'string') {
		if (!exists || reduced.uid !== condition) {
			throw new AgentInstanceNotFoundError({ id: options.id });
		}
		return { uid: reduced.uid };
	}
	if (condition === null && exists) {
		if (reduced.uid === undefined) {
			throw new Error("[flue] invariant: an existing instance's birth record must carry a uid.");
		}
		throw new AgentInstanceExistsError({ id: options.id, uid: reduced.uid });
	}
	if (exists) return { uid: reduced.uid };

	parseCreationData(options.agent, options.initialData);
	return { uid: undefined };
}

/**
 * Validate creation data against the agent's `initialData` contract static
 * (when declared) and return the schema-parsed output — the value renders see
 * and the birth record stores. Shared by admission's contact gate and
 * {@link ensureInstanceIdentity} so both surfaces reject with one message.
 */
function parseCreationData(agent: Agent, initialData: unknown): unknown {
	const schema = resolveAgentInitialDataSchema(agent);
	if (schema === undefined) return initialData;
	const parsed = v.safeParse(schema, initialData);
	if (!parsed.success) {
		throw new InvalidRequestError({
			reason:
				`The agent requires creation data matching its initialData schema: ${parsed.issues
					.map((issue) => issue.message)
					.join('; ')}. ` +
				"Creation data rides the instance's first message ({ initialData, ... } beside the message).",
		});
	}
	return parsed.output;
}

/** The instance identity recorded on the root conversation's birth record. */
export interface InstanceIdentity {
	readonly conversationId: string;
	readonly uid: string;
}

/**
 * Idempotent find-or-create of the instance's birth record — the single code
 * path that creates root instance identity. Admission (both coordinators'
 * dispatch/direct paths and their unready-row recovery passes) calls this
 * before anything renders; execution (`initializeRootHarness`) requires the
 * record to already exist. No render, no sandbox, no workspace discovery.
 *
 * On a miss, the creation data is schema-parsed before it is recorded and the
 * uid is minted here — never carried on the durable submission payload — so a
 * replayed or recovered admission finds the recorded identity and receipts
 * stay deterministic.
 */
export async function ensureInstanceIdentity(
	writer: ConversationRecordWriter,
	agent: Agent,
	initialData: unknown,
): Promise<InstanceIdentity> {
	const existing = await writer.findConversation(SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME);
	if (existing) {
		const { uid } = await writer.loadReducedState();
		if (uid === undefined) {
			throw new Error("[flue] invariant: an existing instance's birth record must carry a uid.");
		}
		return { conversationId: existing.conversationId, uid };
	}
	const data = parseCreationData(agent, initialData);
	const identity = createConversationIdentity();
	const uid = generateInstanceUid();
	await writer.ensureConversation({
		kind: 'root',
		conversationId: identity.conversationId,
		harness: SUBMISSION_HARNESS_NAME,
		session: SUBMISSION_SESSION_NAME,
		affinityKey: identity.affinityKey,
		createdAt: identity.createdAt,
		...(data !== undefined ? { initialData: data } : {}),
		uid,
	});
	return { conversationId: identity.conversationId, uid };
}

export function createDispatchAgentSubmissionInput(input: DispatchInput): AgentSubmissionInput {
	return {
		kind: 'dispatch',
		submissionId: input.submissionId,
		agent: input.agent,
		id: input.id,
		message: input.message,
		...(input.initialData !== undefined ? { initialData: input.initialData } : {}),
		acceptedAt: input.acceptedAt,
	};
}

export function createDirectAgentSubmissionInput(options: {
	agent: string;
	id: string;
	message: DeliveredMessage;
	initialData?: unknown;
	traceCarrier?: FlueTraceCarrier;
}): AgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: generateSubmissionId(),
		agent: options.agent,
		id: options.id,
		message: options.message,
		...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
		acceptedAt: new Date().toISOString(),
		...(options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}),
	};
}

/**
 * Attachments are a property of the delivered message, not of the transport:
 * this persists them for a `kind: 'user'` message regardless of whether the
 * submission arrived as a direct HTTP prompt or a `dispatch()` call. Keyed by
 * the deterministic stream path; `conversationId` (the instance identity's
 * root conversation) is the idempotency stamp the session reads back with.
 * A no-op when the message carries no attachments.
 */
export async function materializeSubmissionAttachments(
	input: AgentSubmissionInput,
	conversationId: string,
	attachmentStore?: AttachmentStore,
): Promise<void> {
	const message = input.message;
	if (message.kind !== 'user' || !attachmentStore) return;
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
			conversationId,
		});
	}
}

export function createAgentSubmissionSessionHandler(
	agent: Agent,
	input: AgentSubmissionInput,
	execute: (session: AgentSubmissionSession) => Promise<unknown> | unknown,
): (ctx: FlueContextInternal) => Promise<unknown> {
	return async (ctx) => {
		const session = await openAgentSubmissionSession(ctx, agent, input);
		return execute(session);
	};
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
	agent: Agent,
	createContext: (submissionId: string) => FlueContextInternal,
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
	const ctx = createContext(input.submissionId);
	const state = (await createAgentSubmissionSessionHandler(agent, input, (s) =>
		s.inspectSubmissionInput(input),
	)(ctx)) as AgentSubmissionInspection;
	if (state === 'completed') {
		await settleJoinedSubmissions(
			submissions,
			attempt,
			ctx,
			'completed',
			undefined,
			conversationWriter,
		);
		await settleSubmissionWithRecord(
			submissions,
			submission.kind,
			attempt,
			ctx,
			'completed',
			undefined,
			conversationWriter,
		);
		return undefined;
	}

	// Abort requested before the owner could settle (it crashed, or the abort
	// never reached a halt point). Settle as the distinct aborted outcome rather
	// than retrying/resuming. Placed AFTER the completed-canonical check — a
	// finished response still settles as success — and BEFORE the
	// retry/timeout/resume branches so a crash-interrupted abort is never
	// resurrected and the attempt budget/timeout cannot pre-empt it.
	if (submission.abortRequestedAt !== undefined) {
		const abortCtx = createContext(input.submissionId);
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
	// when the input was never persisted ('absent' — the stream is the single
	// truth for input application), every attempt was consumed by a
	// claim/interruption cycle (crash, restart, or shutdown) before any
	// provider work started, so "exceeded maximum recovery attempts" would
	// misdescribe work that never happened. The shared budget itself is
	// intentional — only the message distinguishes the case.
	if (submission.attemptCount >= submission.maxAttempts) {
		await failInterruptedSubmission(
			submissions,
			submission,
			attempt,
			agent,
			'exhausted_retry_budget',
			(interruptedTools) =>
				state === 'absent'
					? new SubmissionInterruptedError({
							phase: 'retry_exhausted_before_input',
							attemptCount: submission.attemptCount,
							maxAttempts: submission.maxAttempts,
						})
					: new SubmissionRetryExhaustedError({
							attemptCount: submission.attemptCount,
							maxAttempts: submission.maxAttempts,
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

	// Interrupted: acquire the replacement attempt (the fencing CAS) and hand
	// the submission back to resume processing. No repair happens here, and
	// none is conditional on how the interruption looked when inspected:
	// resume entry converges the stream structurally
	// (`materializeGhostStream` — any in-progress assistant the dead attempt
	// persisted, including a zero-block start, is materialized as an aborted
	// entry, unconditionally and idempotently), then classifies the durable
	// evidence and runs the right continuation:
	//   - a materialized partial with content is upgraded to a stream
	//     continuation (`upgradeAbortedPartialToContinuation`);
	//   - an incomplete tool batch — partial OR zero-result — is repaired by
	//     `repairTrailingPartialToolBatch`, which writes explicit
	//     unknown-outcome errors and NEVER re-executes a tool.
	// Because the CAS precedes resume, the convergence appends always run
	// under an attempt that owns the stream; a reconciler that loses the CAS
	// never mutates session history. The canonical input's presence needs no
	// operational marker to confirm it — 'interrupted' already means the
	// input entry is on the active path (the stream is the single truth) —
	// and a row whose durability was never config-stamped gets stamped by the
	// resume's own once-only `onInputApplied` write.
	//
	// TODO(multi-process): the terminal path (`failInterruptedSubmission`)
	// still appends the `submission_interrupted` advisory before the
	// settlement CAS. This is a BOUNDED hazard, deliberately deferred
	// (2026-07-13 ruling; design + the reserve-first fix are written up as
	// option A in plans/2026-07-13-single-source-of-truth-ledger-design.md —
	// make that the FIRST commit of multi-process support):
	//
	// - Unreachable today: Cloudflare DOs are single-threaded, multi-process
	//   Node is unsupported, and the in-process coordinator serializes
	//   reconciliation against live attempts.
	// - Narrow even if raced: racing reconcilers derive the reason from the
	//   same durable row facts, so their advisories are byte-identical and
	//   the terminal path's idempotency check absorbs the race; content can
	//   only diverge on an exact timeout-boundary clock race. A second
	//   PROCESS must also win the stream's producer claim to write anything,
	//   which fences the other process out of the stream entirely.
	// - Bounded damage: worst case is one advisory signal whose reason
	//   disagrees with the settle record. The settle record is the outcome
	//   authority; nothing downstream misclassifies, and (post settle
	//   barrier) nothing can brick.
	//
	// Why the fix waits: reserve-first needs the settlement error's
	// interruptedTools before the advisory runs (a read-only peek shared
	// with `settleTrailingToolBatch`) and a relaxation of the joined-reserve
	// host-status check (`reserveSubmissionSettlement` requires the host
	// `running`) — both shaped by how multi-process ownership will actually
	// be designed, so building them now would be speculation.
	if (state === 'interrupted') {
		const replacement = await submissions.replaceSubmissionAttempt(
			attempt,
			generateAttemptId(),
			lease,
		);
		if (!replacement?.attemptId) return undefined;
		return replacement;
	}

	// Only 'absent' remains (completed/interrupted handled above): the
	// canonical input was never persisted — the stream is the single truth
	// for input application, and entries survive compaction, so absence
	// means the crash landed before the input append. Requeue for a clean
	// first attempt.
	await submissions.requeueSubmission(attempt);
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
	resolveAgent: (name: string) => Agent;
	/** Build a context for this submission. */
	createContext: (submissionId: string) => FlueContextInternal;
	conversationWriter?: ConversationRecordWriter;
	onInteractionStart?: (interaction: {
		agentName: string;
		instanceId: string;
		kind: AgentSubmission['kind'];
		submissionId: string;
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
			});
		} catch (error) {
			console.error('[flue:submission-processing] interaction start callback failed:', error);
		}
	}

	const agent = opts.resolveAgent(input.agent);
	const ctx = opts.createContext(input.submissionId);

	// Bound to this attempt: the store fences every join operation on the
	// host still running under it, so a replaced attempt's session goes inert.
	const joinSource: SubmissionJoinSource = {
		claim: () => submissions.claimJoinableSubmissions(attempt, input.agent),
		finalize: (submissionId) => submissions.finalizeJoinedSubmission(attempt, submissionId),
		revert: (submissionId) => submissions.revertJoiningSubmission(attempt, submissionId),
		listUnresolved: () => submissions.listJoinedSubmissions(attempt.submissionId),
	};

	const execute = () =>
		createAgentSubmissionSessionHandler(agent, input, (session) => {
			const handle = session.processSubmissionInput(input, {
				joinSource,
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
				// `inputAppliedAt` here is read as the durability-stamp timestamp
				// (its only remaining role — see markSubmissionInputApplied's
				// once-guard), NOT as input-appliedness: the row's timeoutAt is
				// only authoritative once the session config-stamped it; before
				// that it is the claim-time placeholder and the session
				// re-resolves.
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
		await settleJoinedSubmissions(
			submissions,
			attempt,
			ctx,
			'failed',
			error,
			opts.conversationWriter,
		);
		await settleSubmissionWithRecord(
			submissions,
			submission.kind,
			attempt,
			ctx,
			'failed',
			error,
			opts.conversationWriter,
		);
		throw error;
	}
	await settleJoinedSubmissions(
		submissions,
		attempt,
		ctx,
		'completed',
		undefined,
		opts.conversationWriter,
	);
	await settleSubmissionWithRecord(
		submissions,
		submission.kind,
		attempt,
		ctx,
		'completed',
		undefined,
		opts.conversationWriter,
	);
}

// ─── Reconciliation internals ────────────────────────────────────────────────

async function failInterruptedSubmission(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	attempt: SubmissionAttemptRef,
	agent: Agent,
	reason: AgentSubmissionInterruption['reason'],
	createError: (interruptedTools?: ReadonlyArray<InterruptedToolCallRef>) => Error,
	createContext: (submissionId: string) => FlueContextInternal,
	conversationWriter?: ConversationRecordWriter,
): Promise<void> {
	const { input } = submission;
	const ctx = createContext(input.submissionId);
	// The terminal record settles the conversation to a deterministic rest
	// state (ghost stream materialized, unresolved tool calls marker-settled)
	// and reports which calls were interrupted; the settlement error is then
	// built from that report so store waiters carry the same structured
	// metadata. Best-effort: if the record fails (e.g., disk full, SQLite
	// corruption), proceed to settle the submission anyway — a persistent save
	// failure must not leave the submission in an infinite reconciliation loop.
	let interruptedTools: ReadonlyArray<InterruptedToolCallRef> | undefined;
	try {
		interruptedTools = (await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.recordSubmissionTerminal({
				submissionId: submission.submissionId,
				kind: submission.kind,
				reason,
				message: createError(undefined).message,
			}),
		)(ctx)) as ReadonlyArray<InterruptedToolCallRef>;
	} catch (terminalError) {
		console.error(
			'[flue:submission-reconciliation] Failed to record terminal message for submission',
			submission.submissionId,
			terminalError,
		);
	}
	const error = createError(interruptedTools?.length ? interruptedTools : undefined);
	await settleJoinedSubmissions(submissions, attempt, ctx, 'failed', error, conversationWriter);
	await settleSubmissionWithRecord(
		submissions,
		submission.kind,
		attempt,
		ctx,
		'failed',
		error,
		conversationWriter,
	);
}

/**
 * Settle a submission as the distinct `aborted` terminal outcome. Shared by the
 * pre-execution abort check, the in-flight abort catch, and the recovery abort
 * branch.
 *
 * Both kinds record a `submission_aborted` conversation advisory (best-effort —
 * a persistent save failure must not wedge settlement in a reconciliation loop)
 * so the abort is always visible in the message timeline, and both settle
 * through the two-phase outbox with `outcome: 'aborted'` — the durable
 * terminal record a reconnecting waiter observes.
 */
async function settleAbortedWithContext(
	submissions: AgentSubmissionStore,
	submission: AgentSubmission,
	attempt: SubmissionAttemptRef,
	agent: Agent,
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
	await settleJoinedSubmissions(submissions, attempt, ctx, 'aborted', error, conversationWriter);
	await settleSubmissionWithRecord(
		submissions,
		submission.kind,
		attempt,
		ctx,
		'aborted',
		error,
		conversationWriter,
	);
}

/**
 * Settle every delivery joined into the host through the settlement outbox —
 * each gets its durable `submission_settled` record with the host's outcome,
 * reserved and finalized under the host's attempt — so settlement waiters
 * (HTTP `wait()`, an awaited `init()` handle call) always resolve. Runs
 * BEFORE the host's own settle in every terminal path; this ordering shares
 * the single-process hazard model of the pre-settle terminal advisory (see
 * the TODO(multi-process) bounded-hazard note in
 * `reconcileInterruptedSubmission` — same deferral, same fix). Idempotent
 * across re-attempts: a row
 * already terminalizing replays its retained obligation, and one already
 * settled is skipped by the reserve gate. The store's settle fan-out remains
 * the backstop for any joined row still present when the host settles.
 */
async function settleJoinedSubmissions(
	submissions: AgentSubmissionStore,
	hostAttempt: SubmissionAttemptRef,
	ctx: FlueContextInternal,
	outcome: 'completed' | 'failed' | 'aborted',
	error?: unknown,
	conversationWriter?: ConversationRecordWriter,
): Promise<void> {
	for (const joined of await submissions.listJoinedSubmissions(hostAttempt.submissionId)) {
		if (joined.status !== 'joined') continue;
		await settleSubmissionWithRecord(
			submissions,
			joined.kind,
			{ submissionId: joined.submissionId, attemptId: hostAttempt.attemptId },
			ctx,
			outcome,
			error,
			conversationWriter,
		);
	}
}

async function settleSubmissionWithRecord(
	submissions: AgentSubmissionStore,
	kind: AgentSubmission['kind'],
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
	const publishTerminalEvent = async () => {
		// The durable settlement record stays stackless; the live observation
		// additionally carries the classified error (throw-site stack, meta).
		ctx.publishEvent(
			event,
			outcome === 'completed' ? undefined : { errorInfo: classifyError(error) },
		);
		try {
			await ctx.flushEventCallbacks();
		} catch (callbackError) {
			console.error('[flue:subscriber] Terminal event subscriber failed:', callbackError);
		}
	};
	// No canonical stream to record against, or no conversation to anchor the
	// record to (degenerate/test setups, a submission that never materialized):
	// settle the operational row directly so the submission still terminates
	// instead of wedging the session queue.
	const settleOperationalRow = async () => {
		if (outcome === 'completed') await submissions.completeSubmission(attempt);
		else await submissions.failSubmission(attempt, error ?? new SubmissionAbortedError());
		await publishTerminalEvent();
	};
	if (!conversationWriter) {
		await settleOperationalRow();
		return;
	}
	const eventKey = `record_${kind}-submission:${attempt.submissionId}:settled`;
	const reduced = await conversationWriter.loadReducedState();
	const conversation =
		[...reduced.conversations.values()].find((candidate) =>
			[...candidate.entries.values()].some((entry) => entry.submissionId === attempt.submissionId),
		) ??
		[...reduced.conversations.values()].find(
			(candidate) => candidate.harness === 'default' && candidate.session === 'default',
		);
	if (!conversation) {
		await settleOperationalRow();
		return;
	}
	const pending = (await submissions.listPendingSubmissionSettlements()).find(
		(candidate) => candidate.submissionId === attempt.submissionId,
	);
	const settlement = pending?.record ?? {
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
	await publishTerminalEvent();
	await submissions.finalizeSubmissionSettlement(attempt, eventKey, {
		...(outcome === 'completed' || error === undefined
			? {}
			: { errorMessage: error instanceof Error ? error.message : String(error) }),
	});
}

/**
 * Finalize one reserved pending settlement during a reconcile pass: ensure
 * the canonical `submission_settled` record is durable (append the retained
 * record when absent; an existing record must match byte-for-byte), then
 * finalize the operational row. Shared by both coordinators' reconcile
 * passes; everything platform-specific — lease guards, writer acquisition,
 * per-item error containment — stays at the call sites.
 *
 * Deliberately NOT shared with `settleSubmissionWithRecord`, whose mismatch
 * policy is the opposite (log-and-proceed: at settle time the durable
 * canonical record is the client-visible authority, and refusing would wedge
 * reconciliation). Here a mismatch fails loud: the caller leaves the row
 * pending and the next pass retries.
 */
export async function finalizePendingSettlement(
	submissions: AgentSubmissionStore,
	writer: ConversationRecordWriter,
	pending: SubmissionSettlementObligation,
): Promise<void> {
	const attempt = { submissionId: pending.submissionId, attemptId: pending.attemptId };
	const canonical = await writer.getRecord(pending.recordId);
	if (!canonical) await writer.append([pending.record], { submission: attempt });
	else if (JSON.stringify(canonical) !== JSON.stringify(pending.record)) {
		throw new Error(
			'[flue] Pending settlement does not match its canonical record. Clear incompatible beta persistence.',
		);
	}
	await submissions.finalizeSubmissionSettlement(attempt, pending.recordId);
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
	agent: Agent,
	input: AgentSubmissionInput,
): Promise<AgentSubmissionSession> {
	// The submission's delivered message rides into the harness so renders can
	// read it via `useDelivery()` — the durable input, so re-attempts see the
	// same value. Creation data rides along for degenerate contexts that
	// self-provision their conversation runtime; on a durable runtime the
	// birth record admission wrote is the only creation data renders see.
	const harness = await ctx.initializeRootHarness(agent, input.message, input.initialData);
	// External submissions always target the default session of the default
	// harness. `harness.session()` hands out the public FlueSession facade;
	// unwrap it to reach the internal durable submission executor surface.
	// Non-facade objects (test fakes injected through this seam) are used
	// directly via the same structural contract.
	const session = await harness.session(SUBMISSION_SESSION_NAME);
	return getInternalSession(session) ?? (session as unknown as AgentSubmissionSession);
}
