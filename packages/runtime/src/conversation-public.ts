import {
	type ConversationUiMessage,
	type ConversationUiSnapshot,
	classifySignal,
	projectConversationUi,
} from './conversation-projections.ts';
import type { ConversationRecord, SubmissionSettledRecord } from './conversation-records.ts';
import type { ReducedConversationState, ReducedInstanceState } from './conversation-reducer.ts';
import { getActiveConversationPath, toolResultEntryId } from './conversation-reducer.ts';
import { toolResultOutput, toolResultText } from './message-rendering.ts';

interface AgentConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
	/**
	 * The submission whose response answered this one — for a delivery that
	 * joined a live response, the host submission whose reply coalesced it.
	 * Derived at projection time from the attempt shared by the settlement
	 * record and the response's assistant records (nothing stamps it at
	 * settle time). Absent on settlements that predate attempt stamping and
	 * on attempts that produced no assistant message.
	 */
	answeredBySubmissionId?: string;
}

/**
 * A materialized conversation read at a durable-stream offset. Wire-compatible
 * with @flue/sdk's `FlueConversationSnapshot`.
 */
export interface AgentConversationSnapshot {
	v: 1;
	conversationId: string;
	offset: string;
	messages: ConversationUiMessage[];
	settlements: AgentConversationSettlement[];
}

/**
 * Incremental UI projection protocol carried by the `updates` view.
 * Wire-compatible with @flue/sdk's internal `ConversationStreamChunk`. The
 * canonical record schema is never exposed; these chunks describe only
 * UI-relevant conversation operations.
 *
 * Boundary chunks (`message-started`, `tool-input`, `tool-output`,
 * `tool-output-error`, `message-completed`, `submission-settled`) carry the
 * capture-time `timestamp` of their underlying canonical record so run
 * chronology can be reconstructed from the stream. `message-delta`
 * deliberately omits it for wire weight — consumers interpolate between
 * stamped boundaries.
 */
type ConversationStreamChunkBody =
	| { type: 'conversation-reset'; conversationId: string; snapshot: AgentConversationSnapshot }
	| { type: 'message-appended'; conversationId: string; message: ConversationUiMessage }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			/** Turn this assistant message belongs to; the SDK stamps it onto the
			 *  synthesized message so live grouping matches the snapshot projection. */
			turnId?: string;
			/** Agent-authored response metadata from `useResponseStart` hooks. */
			metadata?: Record<string, unknown>;
			/** Capture time (ISO 8601) of the underlying canonical record. */
			timestamp?: string;
	  }
	| {
			type: 'message-metadata';
			conversationId: string;
			messageId: string;
			metadata: Record<string, unknown>;
	  }
	| {
			type: 'data-part';
			conversationId: string;
			messageId: string;
			name: string;
			data: unknown;
	  }
	| {
			type: 'message-delta';
			conversationId: string;
			messageId: string;
			kind: 'text' | 'reasoning';
			delta: string;
	  }
	| {
			type: 'tool-input';
			conversationId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
			timestamp?: string;
	  }
	| {
			type: 'tool-output';
			conversationId: string;
			toolCallId: string;
			output: unknown;
			durationMs?: number;
			timestamp?: string;
	  }
	| {
			type: 'tool-output-error';
			conversationId: string;
			toolCallId: string;
			errorText: string;
			durationMs?: number;
			timestamp?: string;
	  }
	| { type: 'message-completed'; conversationId: string; messageId: string; timestamp?: string }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: unknown;
			/** See {@link AgentConversationSettlement.answeredBySubmissionId}. */
			answeredBySubmissionId?: string;
			timestamp?: string;
	  };

/**
 * Monotonic ordering token stamped on every chunk. `batch` is the durable batch
 * ordinal the chunk was projected from; `index` is the chunk's position within
 * that batch's projection. Consumers compare it (lexicographically by `batch`
 * then `index`) to dedupe chunks redelivered under at-least-once transports
 * (e.g. an SSE reconnect). Opaque otherwise — do not interpret the numbers.
 */
type ConversationChunkPosition = { batch: number; index: number };

export type ConversationStreamChunk = ConversationStreamChunkBody & {
	position: ConversationChunkPosition;
};

// The public conversation API addresses exactly one conversation per agent
// instance: the default harness/session root. An instance can hold other root
// conversations too (internal named sessions each open one), so the default
// must be selected by its stable identity rather than by record order. Fall
// back to any root only when no default scope exists, preserving the prior
// behavior for instances that never used the default session.
const DEFAULT_HARNESS = 'default';
const DEFAULT_SESSION = 'default';

function selectRootConversation(state: ReducedInstanceState) {
	const roots = [...state.conversations.values()].filter(
		(conversation) => conversation.kind === 'root',
	);
	return (
		roots.find(
			(conversation) =>
				conversation.harness === DEFAULT_HARNESS && conversation.session === DEFAULT_SESSION,
		) ?? roots[0]
	);
}

export function projectAgentConversationSnapshot(
	state: ReducedInstanceState,
): AgentConversationSnapshot | undefined {
	const conversation = selectRootConversation(state);
	if (!conversation) return undefined;
	const ui: ConversationUiSnapshot = projectConversationUi(
		conversation,
		state.recordsThroughOffset,
	);
	return {
		v: 1,
		conversationId: conversation.conversationId,
		offset: ui.streamOffset,
		messages: ui.messages,
		settlements: projectSettlements(state, conversation.conversationId),
	};
}

export function projectAgentConversationBatch(options: {
	state: ReducedInstanceState;
	previousState?: ReducedInstanceState;
	records: readonly ConversationRecord[];
	/** Durable batch ordinal these records were read at; stamped onto each chunk. */
	batchOrdinal: number;
}): ConversationStreamChunk[] {
	const conversation =
		selectRootConversation(options.state) ??
		(options.previousState ? selectRootConversation(options.previousState) : undefined);
	if (!conversation) return [];
	const conversationId = conversation.conversationId;
	const relevant = options.records.filter((record) => record.conversationId === conversationId);
	if (relevant.length === 0) return [];

	// A reset subsumes the whole batch: a fresh snapshot already reflects every
	// record in it, so emitting per-record chunks too would double-apply.
	if (relevant.some(requiresSnapshotReset)) {
		const snapshot = projectAgentConversationSnapshot(options.state);
		return snapshot
			? withPositions(
					[{ type: 'conversation-reset', conversationId, snapshot }],
					options.batchOrdinal,
				)
			: [];
	}

	const responseIds = buildResponseMessageIndex(conversation);
	return withPositions(
		relevant.flatMap((record) => encodeRecord(record, conversationId, options.state, responseIds)),
		options.batchOrdinal,
	);
}

/**
 * Map each tracked submission to its response message id — the first
 * assistant messageId recorded for the submission. Chunk encoding rewrites
 * every assistant-scoped record onto this id so the live stream assembles the
 * same one-message-per-response shape the snapshot projection produces (a
 * later step's `message-started` then dedupes client-side and its parts
 * accumulate on the open message).
 */
function buildResponseMessageIndex(conversation: ReducedConversationState): Map<string, string> {
	const first = new Map<string, string>();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== 'message' || entry.message.role !== 'assistant' || !entry.submissionId) {
			continue;
		}
		if (!first.has(entry.submissionId)) first.set(entry.submissionId, entry.id);
	}
	for (const message of conversation.inProgressMessages.values()) {
		if (!message.submissionId || first.has(message.submissionId)) continue;
		first.set(message.submissionId, message.messageId);
	}
	return first;
}

/**
 * Stamp each chunk with its position within the batch. Index is the chunk's
 * order in the batch's projection (a single record may fan out to several
 * chunks), so `{ batch, index }` is globally unique and monotonic across the
 * conversation. This is the identity consumers dedupe on under redelivery.
 */
function withPositions(
	bodies: ConversationStreamChunkBody[],
	batch: number,
): ConversationStreamChunk[] {
	return bodies.map((body, index) => ({ ...body, position: { batch, index } }));
}

function requiresSnapshotReset(record: ConversationRecord): boolean {
	return record.type === 'conversation_created' || record.type === 'compaction';
}

function encodeRecord(
	record: ConversationRecord,
	conversationId: string,
	state: ReducedInstanceState,
	responseIds: Map<string, string>,
): ConversationStreamChunkBody[] {
	// Assistant records of a tracked submission address the submission's
	// response message, not the per-step canonical message.
	const uiMessageId = (messageId: string): string =>
		(record.submissionId ? responseIds.get(record.submissionId) : undefined) ?? messageId;
	switch (record.type) {
		case 'user_message':
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'user',
						purpose: 'user',
						display: 'visible',
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						parts: record.content.map((content) =>
							content.type === 'text'
								? { type: 'text', text: content.text, state: 'done' }
								: {
										type: 'file',
										mediaType: content.attachment.mimeType,
										id: content.attachment.id,
										size: content.attachment.size,
										...(content.attachment.filename
											? { filename: content.attachment.filename }
											: {}),
									},
						),
					},
				},
			];
		case 'signal': {
			const { purpose, display } = classifySignal(record.signalType);
			const signal = {
				...(record.tagName ? { tagName: record.tagName } : {}),
				...(record.attributes ? { attributes: record.attributes } : {}),
			};
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'system',
						purpose,
						display,
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						...(Object.keys(signal).length > 0 ? { signal } : {}),
						parts: [{ type: 'text', text: record.content, state: 'done' }],
					},
				},
			];
		}
		case 'assistant_message_started':
			return [
				{
					type: 'message-started',
					conversationId,
					messageId: uiMessageId(record.messageId),
					...(record.submissionId ? { submissionId: record.submissionId } : {}),
					...(record.turnId ? { turnId: record.turnId } : {}),
					...(record.responseMetadata ? { metadata: record.responseMetadata } : {}),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'message_metadata': {
			const messageId = record.submissionId ? responseIds.get(record.submissionId) : undefined;
			return messageId
				? [{ type: 'message-metadata', conversationId, messageId, metadata: record.metadata }]
				: [];
		}
		case 'message_data_write': {
			const messageId = record.submissionId ? responseIds.get(record.submissionId) : undefined;
			return messageId
				? [{ type: 'data-part', conversationId, messageId, name: record.name, data: record.data }]
				: [];
		}
		case 'assistant_text_delta':
			return [
				{
					type: 'message-delta',
					conversationId,
					messageId: uiMessageId(record.messageId),
					kind: 'text',
					delta: record.delta,
				},
			];
		case 'assistant_reasoning_delta':
			return [
				{
					type: 'message-delta',
					conversationId,
					messageId: uiMessageId(record.messageId),
					kind: 'reasoning',
					delta: record.delta,
				},
			];
		// Block lifecycle (`assistant_text_started`/`assistant_*_completed`) carries no
		// UI-visible payload: the first delta opens a streaming part, a `kind` change or
		// `message-completed` closes it. So those records project to no chunk.
		case 'assistant_tool_call':
			return [
				{
					type: 'tool-input',
					conversationId,
					messageId: uiMessageId(record.messageId),
					toolCallId: record.toolCallId,
					toolName: record.name,
					input: record.arguments,
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'assistant_message_completed':
			return [
				{
					type: 'message-completed',
					conversationId,
					messageId: uiMessageId(record.messageId),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'tool_results_committed': {
			const conversation = state.conversations.get(record.conversationId);
			if (!conversation) return [];
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') return [];
			// The fold guarantees one committed tool-result entry per assistant
			// tool call, in call order — the same entries the snapshot projection
			// renders, so the live stream cannot drift from it.
			return assistant.message.content.flatMap((block) =>
				block.type === 'toolCall'
					? encodeToolResultEntry(conversation, record.assistantMessageId, block.id, conversationId)
					: [],
			);
		}
		case 'submission_settled': {
			if (!record.submissionId) return [];
			const answeredBy =
				typeof record.attemptId === 'string'
					? assistantSubmissionByAttempt(state).get(record.attemptId)
					: undefined;
			return [
				{
					type: 'submission-settled',
					conversationId,
					submissionId: record.submissionId,
					outcome: record.outcome,
					...(record.error === undefined ? {} : { error: record.error }),
					...(answeredBy === undefined ? {} : { answeredBySubmissionId: answeredBy }),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		}
		default:
			return [];
	}
}

function encodeToolResultEntry(
	conversation: ReducedConversationState,
	assistantMessageId: string,
	toolCallId: string,
	conversationId: string,
): ConversationStreamChunkBody[] {
	const entry = conversation.entries.get(toolResultEntryId(assistantMessageId, toolCallId));
	if (entry?.type !== 'message' || entry.message.role !== 'toolResult') return [];
	const result = entry.message;
	// The entry carries the outcome's own capture time (when the tool result
	// was recorded), not the commit record's batch time.
	return result.isError
		? [
				{
					type: 'tool-output-error',
					conversationId,
					toolCallId: result.toolCallId,
					errorText: toolResultText(result.content),
					...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				},
			]
		: [
				{
					type: 'tool-output',
					conversationId,
					toolCallId: result.toolCallId,
					output: entry.toolOutput ? entry.toolOutput.value : toolResultOutput(result.content),
					...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				},
			];
}

function projectSettlements(
	state: ReducedInstanceState,
	conversationId: string,
): AgentConversationSettlement[] {
	const answeredBy = assistantSubmissionByAttempt(state);
	return [...state.recordsById.values()]
		.filter(
			(record): record is SubmissionSettledRecord =>
				record.type === 'submission_settled' &&
				record.conversationId === conversationId &&
				typeof record.submissionId === 'string',
		)
		.map((record) => {
			const by =
				typeof record.attemptId === 'string' ? answeredBy.get(record.attemptId) : undefined;
			return {
				submissionId: record.submissionId as string,
				outcome: record.outcome,
				...(record.error === undefined ? {} : { error: record.error }),
				...(by === undefined ? {} : { answeredBySubmissionId: by }),
			};
		});
}

/**
 * Index attempts to the submission whose response ran them. Every canonical
 * record is envelope-stamped with its attempt, and a joined submission
 * settles under its HOST's attempt — so the settlement→attempt→assistant-
 * record chain resolves which submission's response answered a settlement
 * without any settle path stamping a pointer. Settlements that predate
 * attempt stamping simply miss the index (legacy fallback applies).
 */
function assistantSubmissionByAttempt(state: ReducedInstanceState): Map<string, string> {
	const index = new Map<string, string>();
	for (const record of state.recordsById.values()) {
		if (record.type !== 'assistant_message_started') continue;
		if (typeof record.attemptId !== 'string' || typeof record.submissionId !== 'string') continue;
		index.set(record.attemptId, record.submissionId);
	}
	return index;
}
