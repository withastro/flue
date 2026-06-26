import {
	type ConversationUiMessage,
	type ConversationUiSnapshot,
	projectConversationUi,
} from './conversation-projections.ts';
import type { ConversationRecord, DataRecord, SubmissionSettledRecord } from './conversation-records.ts';
import type { ReducedInstanceState } from './conversation-reducer.ts';

export interface AgentConversationSelector {
	conversationId?: string;
	harness?: string;
	session?: string;
}

export interface AgentConversationDataPart {
	recordId: string;
	name: string;
	id?: string;
	data: unknown;
}

export interface AgentConversationSettlement {
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
	data: AgentConversationDataPart[];
	settlements: AgentConversationSettlement[];
}

export interface AgentConversationRecordUpdate {
	v: 1;
	type: 'conversation_record';
	conversationId: string;
	record: ConversationRecord;
}

export interface AgentConversationSnapshotUpdate {
	v: 1;
	type: 'conversation_reset';
	conversationId: string;
	snapshot: AgentConversationSnapshot;
}

export type AgentConversationUpdate =
	| AgentConversationRecordUpdate
	| AgentConversationSnapshotUpdate;

export function selectAgentConversation(
	state: ReducedInstanceState,
	selector: AgentConversationSelector,
) {
	if (selector.conversationId) {
		const conversation = state.conversations.get(selector.conversationId);
		return conversation?.deleted ? undefined : conversation;
	}
	const harness = selector.harness ?? 'default';
	const session = selector.session ?? 'default';
	const matches = [...state.conversations.values()].filter(
		(conversation) =>
			conversation.harness === harness && conversation.session === session && !conversation.deleted,
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
		data: projectData(state, conversation.conversationId),
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
		.filter((record) => record.type !== 'conversation_created')
		.map((record) => ({
			v: 1,
			type: 'conversation_record',
			conversationId: conversation.conversationId,
			record,
		}));
}

function requiresSnapshotReset(record: ConversationRecord): boolean {
	return (
		record.type === 'conversation_deleted' ||
		record.type === 'active_leaf_changed' ||
		record.type === 'compaction'
	);
}

function projectData(
	state: ReducedInstanceState,
	conversationId: string,
): AgentConversationDataPart[] {
	const values = new Map<string, AgentConversationDataPart>();
	for (const record of state.recordsById.values()) {
		if (record.conversationId !== conversationId || record.type !== 'data') continue;
		const part = dataPart(record);
		const key = record.dataId === undefined ? record.id : JSON.stringify([record.dataType, record.dataId]);
		values.set(key, part);
	}
	return [...values.values()];
}

function dataPart(record: DataRecord): AgentConversationDataPart {
	return {
		recordId: record.id,
		name: record.dataType,
		...(record.dataId === undefined ? {} : { id: record.dataId }),
		data: record.data,
	};
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
