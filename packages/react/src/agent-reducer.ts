import {
	type AgentPromptImage,
	type FlueConversationMessage,
	type FlueConversationState,
} from '@flue/sdk';

export type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

export interface AgentSnapshot {
	messages: FlueConversationMessage[];
	status: AgentStatus;
	historyReady: boolean;
	error: Error | undefined;
}

interface PendingSend {
	localId: string;
	submissionId?: string;
}

export interface AgentState extends AgentSnapshot {
	conversation: FlueConversationState | undefined;
	pendingSends: PendingSend[];
	localSubmissionIds: string[];
	activeSubmissionIds: string[];
}

export type AgentReducerEvent =
	| { type: 'local_send_submitted'; localId: string; message: string; images?: AgentPromptImage[] }
	| { type: 'local_send_admitted'; localId: string; submissionId: string }
	| { type: 'local_send_failed'; localId: string; error: Error }
	| {
			type: 'local_observation';
			conversation: FlueConversationState | undefined;
			phase: 'loading' | 'connecting' | 'live' | 'up-to-date' | 'absent' | 'error' | 'closed';
			error?: Error;
	  };

export const emptyAgentState: AgentState = {
	messages: [],
	status: 'idle',
	historyReady: false,
	error: undefined,
	conversation: undefined,
	pendingSends: [],
	localSubmissionIds: [],
	activeSubmissionIds: [],
};

export function reduceAgentEvent(state: AgentState, event: AgentReducerEvent): AgentState {
	switch (event.type) {
		case 'local_send_submitted': {
			const settledIds = new Set(
				state.conversation?.settlements.map((settlement) => settlement.submissionId) ?? [],
			);
			return {
				...state,
				messages: [...state.messages, optimisticMessage(event)],
				status: 'submitted',
				error: undefined,
				pendingSends: [...state.pendingSends, { localId: event.localId }],
				localSubmissionIds: state.localSubmissionIds.filter((id) => !settledIds.has(id)),
			};
		}
		case 'local_send_admitted':
			return converge({
				...state,
				pendingSends: state.pendingSends.map((send) =>
					send.localId === event.localId ? { ...send, submissionId: event.submissionId } : send,
				),
				localSubmissionIds: addUnique(state.localSubmissionIds, event.submissionId),
				activeSubmissionIds: addUnique(state.activeSubmissionIds, event.submissionId),
			});
		case 'local_send_failed':
			return {
				...state,
				messages: state.messages.filter((message) => message.id !== event.localId),
				status: 'error',
				error: event.error,
				pendingSends: state.pendingSends.filter((send) => send.localId !== event.localId),
			};
		case 'local_observation': {
			if (event.phase === 'error') return { ...state, status: 'error', error: event.error };
			if (event.phase === 'absent') {
				return state.pendingSends.length === 0
					? { ...state, conversation: undefined, messages: [], status: 'idle', historyReady: true, error: undefined }
					: { ...state, status: 'submitted', historyReady: true, error: undefined };
			}
			if (event.conversation) {
				const merged = mergeConversation(state, event.conversation, true);
				return event.phase === 'loading' || event.phase === 'connecting'
					? { ...merged, status: merged.status === 'idle' ? 'connecting' : merged.status, error: event.error }
					: merged;
			}
			return {
				...state,
				status: event.phase === 'loading' || event.phase === 'connecting' ? 'connecting' : state.status,
				error: event.error,
			};
		}
	}
}

function mergeConversation(
	state: AgentState,
	conversation: FlueConversationState,
	historyReady: boolean,
): AgentState {
	return converge({ ...state, conversation, historyReady });
}

function converge(state: AgentState): AgentState {
	const conversation = state.conversation;
	if (!conversation) return state;
	let messages = conversation.messages;
	const pendingSends: PendingSend[] = [];
	const settledIds = new Set(conversation.settlements.map((settlement) => settlement.submissionId));
	for (const pending of state.pendingSends) {
		const canonical = pending.submissionId
			? conversation.messages.find((message) => message.submissionId === pending.submissionId)
			: undefined;
		if (canonical || (pending.submissionId && settledIds.has(pending.submissionId))) continue;
		const optimistic = state.messages.find((message) => message.id === pending.localId);
		if (optimistic) messages = [...messages, optimistic];
		pendingSends.push(pending);
	}
	const ownStreaming = conversation.messages.some(
		(message) =>
			message.role === 'assistant' &&
			message.parts.some(
				(part) =>
					(part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming',
			),
	);
	const failed = conversation.settlements.find(
		(settlement) =>
			settlement.outcome === 'failed' &&
			state.localSubmissionIds.includes(settlement.submissionId),
	);
	const activeSubmissionIds = state.activeSubmissionIds.filter((id) => !settledIds.has(id));
	return {
		...state,
		messages,
		pendingSends,
		activeSubmissionIds,
		status: failed
			? 'error'
			: ownStreaming
				? 'streaming'
				: pendingSends.length > 0
					? 'submitted'
					: activeSubmissionIds.length > 0
						? 'streaming'
						: 'idle',
		error: failed ? new Error(settlementError(failed.error)) : undefined,
	};
}

function optimisticMessage(
	event: Extract<AgentReducerEvent, { type: 'local_send_submitted' }>,
): FlueConversationMessage {
	return {
		id: event.localId,
		role: 'user',
		parts: [
			{ type: 'text', text: event.message, state: 'done' },
			// Opaque attachment reference. Flue does not serve attachment bytes yet,
			// so the optimistic echo carries no data URL — keeping the transcript
			// consistent with the canonical projection after round-trip.
			...(event.images ?? []).map((image) => ({
				type: 'file' as const,
				mediaType: image.mimeType,
			})),
		],
	};
}

function addUnique(values: string[], value: string): string[] {
	return values.includes(value) ? values : [...values, value];
}

function settlementError(value: unknown): string {
	if (value && typeof value === 'object' && 'message' in value) return String(value.message);
	return 'Agent submission failed';
}
