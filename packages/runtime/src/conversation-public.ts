import {
	type ConversationUiMessage,
	type ConversationUiSnapshot,
	projectConversationUi,
} from './conversation-projections.ts';
import type {
	CanonicalToolResultContent,
	ConversationRecord,
	ConversationRecordEnvelope,
	SubmissionSettledRecord,
} from './conversation-records.ts';
import { toolResultEntryId, type ReducedInstanceState } from './conversation-reducer.ts';
import { ConversationRecordInvariantError } from './errors.ts';

export interface AgentConversationSelector {
	conversationId?: string;
	harness?: string;
	session?: string;
}

interface AgentConversationSettlement {
	recordId: string;
	submissionId: string;
	outcome: 'completed' | 'failed';
	result?: unknown;
	error?: unknown;
}

export interface AgentConversationSnapshot {
	v: 1;
	type: 'conversation_snapshot';
	conversationId: string;
	harness: string;
	session: string;
	offset: string;
	messages: ConversationUiMessage[];
	settlements: AgentConversationSettlement[];
}

interface ProjectedToolResultRecord extends ConversationRecordEnvelope {
	type: 'tool_result';
	messageId: string;
	parentId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: CanonicalToolResultContent[];
}

interface AgentConversationRecordUpdate {
	v: 1;
	type: 'conversation_record';
	conversationId: string;
	record: ConversationRecord | ProjectedToolResultRecord;
}

interface AgentConversationSnapshotUpdate {
	v: 1;
	type: 'conversation_reset';
	conversationId: string;
	snapshot: AgentConversationSnapshot;
}

export type AgentConversationUpdate =
	| AgentConversationRecordUpdate
	| AgentConversationSnapshotUpdate;

function selectAgentConversation(
	state: ReducedInstanceState,
	selector: AgentConversationSelector,
) {
	if (selector.conversationId) {
		return state.conversations.get(selector.conversationId);
	}
	const harness = selector.harness ?? 'default';
	const session = selector.session ?? 'default';
	const matches = [...state.conversations.values()].filter(
		(conversation) => conversation.harness === harness && conversation.session === session,
	);
	if (matches.length > 1) {
		throw new Error('[flue] Multiple active canonical conversations share one session scope.');
	}
	return matches[0];
}

export function projectAgentConversationSnapshot(
	state: ReducedInstanceState,
	selector: AgentConversationSelector,
): AgentConversationSnapshot | undefined {
	const conversation = selectAgentConversation(state, selector);
	if (!conversation) return undefined;
	const ui: ConversationUiSnapshot = projectConversationUi(
		conversation,
		state.recordsThroughOffset,
	);
	return {
		v: 1,
		type: 'conversation_snapshot',
		conversationId: conversation.conversationId,
		harness: conversation.harness,
		session: conversation.session,
		offset: ui.streamOffset,
		messages: ui.messages,
		settlements: projectSettlements(state, conversation.conversationId),
	};
}

export function projectAgentConversationBatch(options: {
	state: ReducedInstanceState;
	previousState?: ReducedInstanceState;
	selector: AgentConversationSelector;
	records: readonly ConversationRecord[];
}): AgentConversationUpdate[] {
	const conversation =
		selectAgentConversation(options.state, options.selector) ??
		(options.previousState
			? selectAgentConversation(options.previousState, options.selector)
			: undefined);
	if (!conversation) return [];
	const relevant = options.records.filter(
		(record) => record.conversationId === conversation.conversationId,
	);
	if (relevant.length === 0) return [];
	if (relevant.some((record) => record.type === 'conversation_created' || requiresSnapshotReset(record))) {
		const snapshot = projectAgentConversationSnapshot(options.state, options.selector);
		return snapshot
			? [
					{
						v: 1,
						type: 'conversation_reset',
						conversationId: conversation.conversationId,
						snapshot,
					},
				]
			: [];
	}
	return relevant
		.flatMap((record): Array<ConversationRecord | ProjectedToolResultRecord> => {
			if (record.type === 'conversation_created' || record.type === 'tool_outcome') return [];
			if (record.type !== 'tool_results_committed') return [record];
			let parentId = record.parentId;
			return record.outcomeIds.map((outcomeId) => {
				const outcome = options.state.recordsById.get(outcomeId);
				if (
					outcome?.type !== 'tool_outcome' ||
					outcome.conversationId !== record.conversationId ||
					outcome.harness !== record.harness ||
					outcome.session !== record.session
				) {
					throw new ConversationRecordInvariantError({
						recordId: record.id,
						recordType: record.type,
						reason: `Committed tool outcome "${outcomeId}" is unavailable to the public projection.`,
					});
				}
				const projected = projectedToolResultRecord(record, outcome, parentId);
				parentId = projected.messageId;
				return projected;
			});
		})
		.map((record) => ({
			v: 1,
			type: 'conversation_record' as const,
			conversationId: conversation.conversationId,
			record,
		}));
}

function projectedToolResultRecord(
	commit: Extract<ConversationRecord, { type: 'tool_results_committed' }>,
	outcome: Extract<ConversationRecord, { type: 'tool_outcome' }>,
	parentId: string,
): ProjectedToolResultRecord {
	return {
		...commit,
		id: toolResultEntryId(commit.assistantMessageId, outcome.toolCallId).replace('entry_', 'record_'),
		type: 'tool_result',
		messageId: toolResultEntryId(commit.assistantMessageId, outcome.toolCallId),
		parentId,
		toolCallId: outcome.toolCallId,
		toolName: outcome.toolName,
		isError: outcome.isError,
		content: outcome.content,
	};
}

function requiresSnapshotReset(record: ConversationRecord): boolean {
	return record.type === 'active_leaf_changed' || record.type === 'compaction';
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
			recordId: record.id,
			submissionId: record.submissionId as string,
			outcome: record.outcome,
			...(record.result === undefined ? {} : { result: record.result }),
			...(record.error === undefined ? {} : { error: record.error }),
		}));
}
