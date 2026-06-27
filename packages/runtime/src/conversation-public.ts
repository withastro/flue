import {
	type ConversationUiMessage,
	type ConversationUiSnapshot,
	projectConversationUi,
} from './conversation-projections.ts';
import type {
	CanonicalToolResultContent,
	ConversationRecord,
	SubmissionSettledRecord,
} from './conversation-records.ts';
import type { PromptUsage } from './types.ts';
import { type ReducedInstanceState } from './conversation-reducer.ts';

interface AgentConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed';
	result?: unknown;
	error?: unknown;
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
 */
export type ConversationStreamChunk =
	| { type: 'conversation-reset'; conversationId: string; snapshot: AgentConversationSnapshot }
	| { type: 'message-appended'; conversationId: string; message: ConversationUiMessage }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			model?: { provider: string; id: string };
	  }
	| {
			type: 'part-start';
			conversationId: string;
			messageId: string;
			partId: string;
			kind: 'text' | 'reasoning';
	  }
	| {
			type: 'part-delta';
			conversationId: string;
			messageId: string;
			partId: string;
			kind: 'text' | 'reasoning';
			sequence: number;
			delta: string;
	  }
	| { type: 'part-end'; conversationId: string; messageId: string; partId: string }
	| {
			type: 'tool-input';
			conversationId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
	  }
	| { type: 'tool-output'; conversationId: string; toolCallId: string; output: unknown }
	| { type: 'tool-output-error'; conversationId: string; toolCallId: string; errorText: string }
	| { type: 'message-completed'; conversationId: string; messageId: string; usage?: PromptUsage }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed';
			result?: unknown;
			error?: unknown;
	  };

/** The default public conversation for an agent instance is its root conversation. */
function selectRootConversation(state: ReducedInstanceState) {
	return [...state.conversations.values()].find((conversation) => conversation.kind === 'root');
}

export function projectAgentConversationSnapshot(
	state: ReducedInstanceState,
): AgentConversationSnapshot | undefined {
	const conversation = selectRootConversation(state);
	if (!conversation) return undefined;
	const ui: ConversationUiSnapshot = projectConversationUi(conversation, state.recordsThroughOffset);
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
		return snapshot ? [{ type: 'conversation-reset', conversationId, snapshot }] : [];
	}

	return relevant.flatMap((record) => encodeRecord(record, conversationId, options.state));
}

function requiresSnapshotReset(record: ConversationRecord): boolean {
	return (
		record.type === 'conversation_created' ||
		record.type === 'active_leaf_changed' ||
		record.type === 'compaction'
	);
}

function encodeRecord(
	record: ConversationRecord,
	conversationId: string,
	state: ReducedInstanceState,
): ConversationStreamChunk[] {
	switch (record.type) {
		case 'user_message':
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'user',
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						parts: record.content.map((content) =>
							content.type === 'text'
								? { type: 'text', text: content.text, state: 'done' }
								: { type: 'file', mediaType: content.attachment.mimeType },
						),
					},
				},
			];
		case 'signal':
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'user',
						parts: [{ type: 'text', text: record.content, state: 'done' }],
					},
				},
			];
		case 'assistant_message_started':
			return [
				{
					type: 'message-started',
					conversationId,
					messageId: record.messageId,
					...(record.submissionId ? { submissionId: record.submissionId } : {}),
					...(typeof record.modelInfo.provider === 'string' && typeof record.modelInfo.model === 'string'
						? { model: { provider: record.modelInfo.provider, id: record.modelInfo.model } }
						: {}),
				},
			];
		case 'assistant_text_started':
			return [{ type: 'part-start', conversationId, messageId: record.messageId, partId: record.blockId, kind: 'text' }];
		case 'assistant_reasoning_started':
			return [{ type: 'part-start', conversationId, messageId: record.messageId, partId: record.blockId, kind: 'reasoning' }];
		case 'assistant_text_delta':
			return [{ type: 'part-delta', conversationId, messageId: record.messageId, partId: record.blockId, kind: 'text', sequence: record.sequence, delta: record.delta }];
		case 'assistant_reasoning_delta':
			return [{ type: 'part-delta', conversationId, messageId: record.messageId, partId: record.blockId, kind: 'reasoning', sequence: record.sequence, delta: record.delta }];
		case 'assistant_text_completed':
		case 'assistant_reasoning_completed':
			return [{ type: 'part-end', conversationId, messageId: record.messageId, partId: record.blockId }];
		case 'assistant_tool_call':
			return [{ type: 'tool-input', conversationId, messageId: record.messageId, toolCallId: record.toolCallId, toolName: record.name, input: record.arguments }];
		case 'assistant_message_completed':
			return [
				{
					type: 'message-completed',
					conversationId,
					messageId: record.messageId,
					...(record.usage ? { usage: record.usage as PromptUsage } : {}),
				},
			];
		case 'tool_results_committed':
			return record.outcomeIds.flatMap((outcomeId) =>
				encodeToolOutcome(outcomeId, conversationId, record, state),
			);
		case 'submission_settled':
			return record.submissionId
				? [
						{
							type: 'submission-settled',
							conversationId,
							submissionId: record.submissionId,
							outcome: record.outcome,
							...(record.result === undefined ? {} : { result: record.result }),
							...(record.error === undefined ? {} : { error: record.error }),
						},
					]
				: [];
		default:
			return [];
	}
}

function encodeToolOutcome(
	outcomeId: string,
	conversationId: string,
	commit: Extract<ConversationRecord, { type: 'tool_results_committed' }>,
	state: ReducedInstanceState,
): ConversationStreamChunk[] {
	const outcome = state.recordsById.get(outcomeId);
	if (
		outcome?.type !== 'tool_outcome' ||
		outcome.conversationId !== commit.conversationId ||
		outcome.harness !== commit.harness ||
		outcome.session !== commit.session
	) {
		return [];
	}
	return outcome.isError
		? [{ type: 'tool-output-error', conversationId, toolCallId: outcome.toolCallId, errorText: toolResultText(outcome.content) }]
		: [
				{
					type: 'tool-output',
					conversationId,
					toolCallId: outcome.toolCallId,
					output: outcome.output !== undefined ? outcome.output : toolResultOutput(outcome.content),
				},
			];
}

function projectSettlements(
	state: ReducedInstanceState,
	conversationId: string,
): AgentConversationSettlement[] {
	return [...state.recordsById.values()]
		.filter(
			(record): record is SubmissionSettledRecord =>
				record.conversationId === conversationId &&
				record.type === 'submission_settled' &&
				typeof record.submissionId === 'string',
		)
		.map((record) => ({
			submissionId: record.submissionId as string,
			outcome: record.outcome,
			...(record.result === undefined ? {} : { result: record.result }),
			...(record.error === undefined ? {} : { error: record.error }),
		}));
}

function toolResultOutput(content: CanonicalToolResultContent[]): unknown {
	if (content.length === 1 && content[0]?.type === 'text') return content[0].text;
	return content;
}

function toolResultText(content: CanonicalToolResultContent[]): string {
	return content
		.filter((block): block is Extract<CanonicalToolResultContent, { type: 'text' }> => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}
