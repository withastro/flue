/**
 * Pure classifier for the persisted state of an agent-submission input.
 *
 * Given the active-path entries that follow a persisted submission input,
 * `classifySubmissionState` determines how far the submission progressed
 * before the session was last saved. It is the single source of truth for
 * both consumers in `session.ts`:
 *
 * - `inspectPersistedInput`, which maps the fine-grained state onto the
 *   coarse `AgentSubmissionInspection` union used by reconciliation, and
 * - the `runPersistedContextInput` preamble, which decides whether to
 *   resume, settle, or fail when (re)processing the input.
 *
 * The two consumers intentionally do NOT agree on every state. The current
 * divergences, pinned by `test/submission-state.test.ts`:
 *
 * - `resume` with mode `overflow` or `input_only`: the preamble resumes
 *   these, but inspection reports `'uncertain'` — reconciliation
 *   compensates with its provider-unreached retry special case (see
 *   `reconcileInterruptedSubmission`).
 * - `completed` with `overflow: true` (silent or truncation overflow on a
 *   stop/length response): inspection reports `'completed'`, but the
 *   preamble treats it as an overflow resume (compact and continue).
 * - `tool_use_unresolved`: inspection reports `'uncertain'`, but the
 *   preamble settles with the persisted response without resuming.
 * - `advanced_past_input`: inspection reports `'uncertain'`, the preamble
 *   fails the operation.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from './compaction.ts';
import type { MessageEntry, SessionEntry } from './types.ts';

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
 *   turn). The partial is excluded from model context, so resuming replays
 *   the turn from the last durable user/toolResult message; the collected
 *   partial output stays preserved in history. When canonical partial deltas
 *   exist, reconciliation upgrades this state to `stream_continuation` via
 *   `recoverInterruptedStream` before processing resumes.
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
	/** A later user input exists: the session moved on without settling this input. */
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
 * Classify how far a persisted submission input progressed.
 *
 * @param following - `history.getActivePathSince(inputEntry.id)` for the
 *   persisted input entry, or `undefined` when the input entry is absent
 *   from history.
 * @param opts.contextWindow - The active model's context window, used for
 *   silent-overflow detection; pass 0 when no model is resolved (only
 *   explicit overflow error messages are detected then).
 */
export function classifySubmissionState(
	following: SessionEntry[] | undefined,
	opts: { contextWindow: number },
): SubmissionState {
	if (following === undefined) return { kind: 'absent' };
	if (following.some((entry) => entry.type === 'message' && entry.message.role === 'user')) {
		return { kind: 'advanced_past_input' };
	}
	const assistant = following.findLast(
		(entry): entry is MessageEntry =>
			entry.type === 'message' && entry.message.role === 'assistant',
	)?.message as AssistantMessage | undefined;
	if (!assistant) {
		return {
			kind: 'resume',
			mode: 'input_only',
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	const overflow = isContextOverflow(assistant, opts.contextWindow);
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
		following.some(
			(entry) =>
				entry.type === 'message' &&
				entry.message.role === 'signal' &&
				entry.message.type === 'stream_continued',
		)
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
 * complete (every call id has a recorded result), when a recovered stream
 * continuation exists (resumption continues from the recovered partial and
 * must not rewind history), or when any unexpected entry interrupts the
 * trailing `assistant → toolResults → [aborted assistant]` shape.
 *
 * Both the classifier and the session-side repair derive the batch through
 * this single function so they can never disagree about which turn is
 * incomplete.
 */
export function findTrailingPartialToolBatch(
	following: SessionEntry[],
): TrailingPartialToolBatch | undefined {
	if (
		following.some(
			(entry) =>
				entry.type === 'message' &&
				entry.message.role === 'signal' &&
				entry.message.type === 'stream_continued',
		)
	) {
		return undefined;
	}
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

export function isRetryableModelError(message: AssistantMessage): boolean {
	if (message.stopReason !== 'error' || !message.errorMessage) return false;
	return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i.test(
		message.errorMessage,
	);
}

export function isCompletedAssistantResponse(message: AssistantMessage): boolean {
	return message.stopReason === 'stop' || message.stopReason === 'length';
}

export function countConsecutiveRetryableModelErrors(entries: SessionEntry[]): number {
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
