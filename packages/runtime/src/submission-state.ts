/**
 * Pure classifier for the persisted state of an agent-submission input.
 *
 * Given the active-path entries that follow a persisted submission input,
 * `classifySubmissionState` determines how far the submission progressed
 * before the session was last saved. It is the single source of truth for
 * both consumers in `session.ts`:
 *
 * - `inspectCanonicalState`, which maps the fine-grained state onto the
 *   coarse `AgentSubmissionInspection` union used by reconciliation
 *   (`'absent' | 'completed' | 'interrupted'` — everything that is neither
 *   absent nor completed is one bucket, because reconciliation's only move
 *   is to fence in a replacement attempt and hand the submission back to
 *   resume processing; repair is never conditional on the coarse mapping),
 *   and
 * - the `runPersistedContextInput` preamble, which decides whether to
 *   resume, settle, or fail when (re)processing the input — after the
 *   ownership seam has already converged the stream structurally
 *   (`materializeGhostStream`), so classification only ever sees committed
 *   entries.
 *
 * The two consumers intentionally do NOT agree on every state. The current
 * divergences, pinned by `test/submission-state.test.ts`:
 *
 * - `completed` with `overflow: true` (silent or truncation overflow on a
 *   stop/length response): inspection reports `'completed'`, but the
 *   preamble treats it as an overflow resume (compact and continue).
 * - `advanced_past_input` and `terminal_error`: inspection reports
 *   `'interrupted'` (a replacement attempt is granted), but the preamble
 *   fails the operation — the failed attempts burn down the retry budget to
 *   a terminal settle rather than resuming.
 *
 * `tool_use_unresolved` inspects as `'interrupted'` and the preamble repairs
 * the trailing tool batch (unresolved calls get explicit unknown-outcome
 * errors — never a blind re-execution; only `durable: true` tool calls
 * re-execute, replaying recorded steps) and continues — identical to a
 * partial batch. Canonical recovery cannot prove a tool "never started", so
 * it conservatively repairs and lets the model proceed.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isAssistantContextOverflow } from './compaction.ts';
import { RETRYABLE_INTERRUPTION_MARKER } from './errors.ts';

export type CanonicalSubmissionEntry =
	| {
			id: string;
			type: 'message';
			message: AgentMessage;
			/** The submission that owns this entry, when one was active at record time. */
			submissionId?: string;
	  }
	| { id: string; type: 'compaction' };

/**
 * How a `resume` state continues the interrupted submission:
 *
 * - `input_only` — the input was applied but no assistant response was
 *   persisted; start the first turn.
 * - `tool_results` — a toolUse response whose persisted tool results form a
 *   complete batch; continue the loop from the results.
 * - `tool_results_partial` — the trailing toolUse turn carries an
 *   incomplete tool-result batch (the turn was interrupted mid-batch, e.g.
 *   graceful shutdown broke the tool loop after some calls completed). An
 *   incomplete batch is excluded from model context, so a plain resume
 *   would replay the turn and RE-EXECUTE the calls that already completed.
 *   Resumption must first repair the batch — preserve every recorded
 *   result, synthesize interrupted-markers for the unresolved calls — and
 *   only then continue (see `findTrailingPartialToolBatch`).
 * - `stream_continuation` — an aborted response already recovered from
 *   canonical deltas (a `stream_continued` signal follows it); continue from
 *   the recovered partial.
 * - `transient_retry` — a retryable model error; wait out the backoff and
 *   retry the turn.
 * - `overflow` — a context-overflow response; compact and retry the turn.
 * - `aborted_partial` — an aborted response without a recovered stream
 *   continuation (e.g. checkpointed when graceful shutdown aborted the
 *   turn, or materialized from an interrupted in-progress stream at the
 *   resume seam). The partial is excluded from model context, so resuming
 *   replays the turn from the last durable user/toolResult message; the
 *   collected partial output stays preserved in history. When the partial
 *   carries continuable content, the resume path upgrades this state to
 *   `stream_continuation` via `upgradeAbortedPartialToContinuation`.
 */
type SubmissionResumeMode =
	| 'input_only'
	| 'tool_results'
	| 'tool_results_partial'
	| 'stream_continuation'
	| 'transient_retry'
	| 'overflow'
	| 'aborted_partial';

export type SubmissionState =
	/** The persisted input entry was not found in session history. */
	| { kind: 'absent' }
	/**
	 * A later user input exists: the session moved on without settling this
	 * input. User messages joined into this submission's own response by the
	 * turn-boundary join protocol do not count — they are absorbed input, not
	 * advancement (see `isJoinedDeliveryInput`).
	 */
	| { kind: 'advanced_past_input' }
	/**
	 * The last assistant response is canonical (stopReason stop/length).
	 * `overflow` flags silent/truncation overflow on that response — see the
	 * module doc for the consumer divergence it encodes.
	 */
	| { kind: 'completed'; assistant: AssistantMessage; overflow: boolean }
	/** A toolUse response with no persisted tool results. */
	| { kind: 'tool_use_unresolved'; assistant: AssistantMessage }
	/** A non-retryable error response. */
	| { kind: 'terminal_error'; reason: string }
	| {
			kind: 'resume';
			mode: 'input_only';
			assistant?: undefined;
			consecutiveRetryableErrors: number;
	  }
	| {
			kind: 'resume';
			mode: Exclude<SubmissionResumeMode, 'input_only'>;
			assistant: AssistantMessage;
			consecutiveRetryableErrors: number;
	  };

/**
 * A user message absorbed into the classified submission's own response by
 * the turn-boundary join protocol (a queued direct delivery), rather than a
 * later input the session moved on to. A joined delivery's record carries
 * the DELIVERY's `submissionId` — never the host's — while every record the
 * host writes carries the host's own, and programmatic `session.prompt()`
 * inputs carry none. Recognized only when the classified input's owning
 * submission is known: joins exist solely under coordinator submissions, so
 * an unowned input (degenerate/test setups, subagent reattach) keeps the
 * strict reading.
 */
function isJoinedDeliveryInput(
	entry: Extract<CanonicalSubmissionEntry, { type: 'message' }>,
	ownSubmissionId: string | undefined,
): boolean {
	return (
		ownSubmissionId !== undefined &&
		entry.submissionId !== undefined &&
		entry.submissionId !== ownSubmissionId
	);
}

/**
 * Classify how far a persisted submission input progressed.
 *
 * @param following - `history.getActivePathSince(inputEntry.id)` for the
 *   persisted input entry, or `undefined` when the input entry is absent
 *   from history.
 * @param opts.contextWindow - The active model's context window, used for
 *   silent-overflow detection; pass 0 when no model is resolved (only
 *   explicit overflow error messages are detected then).
 * @param opts.ownSubmissionId - The submission that owns the classified
 *   input entry. User messages joined into that submission's response (see
 *   {@link isJoinedDeliveryInput}) are continuation input for the same
 *   response, not the session advancing past the input.
 */
export function classifySubmissionState(
	following: readonly CanonicalSubmissionEntry[] | undefined,
	opts: { contextWindow: number; ownSubmissionId?: string },
): SubmissionState {
	if (following === undefined) return { kind: 'absent' };
	if (
		following.some(
			(entry) =>
				entry.type === 'message' &&
				entry.message.role === 'user' &&
				!isJoinedDeliveryInput(entry, opts.ownSubmissionId),
		)
	) {
		return { kind: 'advanced_past_input' };
	}
	const assistantIndex = following.findLastIndex(
		(entry) => entry.type === 'message' && entry.message.role === 'assistant',
	);
	const assistantEntry = assistantIndex === -1 ? undefined : following[assistantIndex];
	const assistant =
		assistantEntry?.type === 'message' ? (assistantEntry.message as AssistantMessage) : undefined;
	if (!assistant) {
		return {
			kind: 'resume',
			mode: 'input_only',
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	const overflow = isAssistantContextOverflow(assistant, opts.contextWindow);
	if (isCompletedAssistantResponse(assistant)) {
		return { kind: 'completed', assistant, overflow };
	}
	if (overflow) {
		return {
			kind: 'resume',
			mode: 'overflow',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (isRetryableModelError(assistant)) {
		return {
			kind: 'resume',
			mode: 'transient_retry',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (
		assistant.stopReason === 'aborted' &&
		hasAdjacentStreamContinuation(following, assistantIndex)
	) {
		return {
			kind: 'resume',
			mode: 'stream_continuation',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (assistant.stopReason === 'toolUse') {
		if (
			following.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
		) {
			return {
				kind: 'resume',
				mode: findTrailingPartialToolBatch(following) ? 'tool_results_partial' : 'tool_results',
				assistant,
				consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
			};
		}
		return { kind: 'tool_use_unresolved', assistant };
	}
	if (assistant.stopReason === 'aborted') {
		// A turn interrupted mid-tool-batch leaves a trailing aborted
		// assistant behind the partial batch: after the broken tool loop, the
		// agent loop starts the next turn, which aborts at the provider and
		// is checkpointed last. The batch — not the empty aborted partial —
		// is the state that must drive resumption.
		if (findTrailingPartialToolBatch(following)) {
			return {
				kind: 'resume',
				mode: 'tool_results_partial',
				assistant,
				consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
			};
		}
		// An aborted partial without a recovered stream continuation. The
		// abort itself is not a property of the work (graceful shutdown is
		// the canonical producer), so the submission is resumable: the
		// partial is excluded from model context and the turn replays from
		// the last durable message.
		return {
			kind: 'resume',
			mode: 'aborted_partial',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	// stopReason 'error', non-retryable and non-overflow.
	return { kind: 'terminal_error', reason: assistant.errorMessage ?? assistant.stopReason };
}

/**
 * Whether the recovery signal pair immediately follows the entry at
 * `abortedIndex` — the SAME adjacency rule the context builder uses to decide
 * whether the aborted partial enters model context (conversation-reducer.ts,
 * `pathToContextEntries`). Classification and context inclusion must never
 * disagree: an id-anywhere check would claim "recovered" for a partial the
 * model cannot see. Adjacency is guaranteed by construction — the pair is
 * appended only while the aborted partial is the leaf
 * (`upgradeAbortedPartialToContinuation`) and appends are linear — so a
 * `stream_continued` anywhere else in the window is stale by definition.
 */
function hasAdjacentStreamContinuation(
	following: readonly CanonicalSubmissionEntry[],
	abortedIndex: number,
): boolean {
	const next = following[abortedIndex + 1];
	const afterNext = following[abortedIndex + 2];
	return (
		next?.type === 'message' &&
		next.message.role === 'signal' &&
		next.message.type === 'stream_interrupted' &&
		afterNext?.type === 'message' &&
		afterNext.message.role === 'signal' &&
		afterNext.message.type === 'stream_continued'
	);
}

export interface TrailingPartialToolBatch {
	/** History entry id of the toolUse assistant whose batch is incomplete. */
	entryId: string;
	assistant: AssistantMessage;
	/** The turn's full tool-call set, in original call order. */
	toolCalls: Array<{ type: 'toolCall'; id: string; name: string }>;
}

/**
 * Locate the trailing toolUse turn whose persisted tool-result batch is
 * incomplete — the persistence shape left behind when an abort breaks the
 * tool loop mid-batch. The toolUse assistant is either the last assistant in
 * `following`, or the second-to-last when the final entry is the aborted
 * partial of the next turn the abort also cut short.
 *
 * Conservative by construction: returns undefined when the batch is
 * complete (every call id has a recorded result) or when any unexpected
 * entry interrupts the trailing `assistant → toolResults → [aborted
 * assistant]` shape.
 *
 * A recovered stream continuation (resumption continues from the recovered
 * partial and must not rewind history) needs no scan: the recovery signal
 * pair adjacently follows its aborted assistant forever (appended only at
 * the leaf, appends linear — the same adjacency rule the context builder
 * enforces, see `hasAdjacentStreamContinuation`), so a recovered tail ends
 * in signal entries the structural walk below rejects on its own, and a
 * pair anywhere earlier is stale by definition and must not veto repair of
 * a later trailing batch.
 *
 * Both the classifier and the session-side repair derive the batch through
 * this single function so they can never disagree about which turn is
 * incomplete.
 */
export function findTrailingPartialToolBatch(
	following: readonly CanonicalSubmissionEntry[],
): TrailingPartialToolBatch | undefined {
	let end = following.length;
	const lastEntry = following[end - 1];
	if (
		lastEntry?.type === 'message' &&
		lastEntry.message.role === 'assistant' &&
		(lastEntry.message as AssistantMessage).stopReason === 'aborted'
	) {
		end -= 1;
	}
	// Walk back over the trailing toolResult run to the assistant that owns it.
	let index = end - 1;
	const resultIds = new Set<string>();
	while (index >= 0) {
		const entry = following[index];
		if (entry?.type !== 'message' || entry.message.role !== 'toolResult') break;
		resultIds.add(entry.message.toolCallId);
		index -= 1;
	}
	const assistantEntry = following[index];
	if (
		index < 0 ||
		assistantEntry?.type !== 'message' ||
		assistantEntry.message.role !== 'assistant'
	) {
		return undefined;
	}
	const assistant = assistantEntry.message as AssistantMessage;
	if (assistant.stopReason !== 'toolUse') return undefined;
	const toolCalls = assistant.content.flatMap((content) =>
		content.type === 'toolCall'
			? [{ type: 'toolCall' as const, id: content.id, name: content.name }]
			: [],
	);
	if (toolCalls.length === 0) return undefined;
	if (toolCalls.every((toolCall) => resultIds.has(toolCall.id))) return undefined;
	return { entryId: assistantEntry.id, assistant, toolCalls };
}

/**
 * Whether an errored assistant message is worth re-attempting under the
 * bounded in-loop retry budget. A throw site that can PROVE its failure was
 * a transient interruption stamps `RETRYABLE_INTERRUPTION_MARKER` into the
 * message (the persisted record carries only `errorMessage` text, so the
 * marker is the transport) — checked first. The pattern list is the
 * best-effort heuristic for error messages Flue does not author.
 */
export function isRetryableModelError(message: AssistantMessage): boolean {
	if (message.stopReason !== 'error' || !message.errorMessage) return false;
	if (message.errorMessage.includes(RETRYABLE_INTERRUPTION_MARKER)) return true;
	return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i.test(
		message.errorMessage,
	);
}

function isCompletedAssistantResponse(message: AssistantMessage): boolean {
	return message.stopReason === 'stop' || message.stopReason === 'length';
}

export function countConsecutiveRetryableModelErrors(
	entries: readonly CanonicalSubmissionEntry[],
): number {
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== 'message') continue;
		// User messages mark an operation boundary: errors from a previous
		// operation must not count against the current one.
		if (entry.message.role === 'user') return count;
		if (entry.message.role !== 'assistant') continue;
		if (!isRetryableModelError(entry.message as AssistantMessage)) return count;
		count += 1;
	}
	return count;
}
