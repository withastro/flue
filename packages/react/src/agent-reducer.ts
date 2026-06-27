import {
	type AgentConversationMessage,
	type AgentConversationSnapshot,
	type AgentConversationState,
	type AgentConversationUpdate,
	type AgentPromptImage,
	createAgentConversationState,
	reduceAgentConversationUpdate,
} from '@flue/sdk';
import type { UIMessage, UIMessagePart } from './types.ts';

export type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

export interface AgentSnapshot {
	messages: UIMessage[];
	status: AgentStatus;
	historyReady: boolean;
	error: Error | undefined;
}

interface PendingSend {
	localId: string;
	submissionId?: string;
}

export interface AgentState extends AgentSnapshot {
	conversation: AgentConversationState | undefined;
	pendingSends: PendingSend[];
	localSubmissionIds: string[];
	activeSubmissionIds: string[];
}

type LocalAgentEvent =
	| { type: 'local_send_submitted'; localId: string; message: string; images?: AgentPromptImage[] }
	| { type: 'local_send_admitted'; localId: string; submissionId: string }
	| { type: 'local_send_failed'; localId: string; error: Error }
	| { type: 'local_connecting'; error?: Error }
	| { type: 'local_history'; snapshot: AgentConversationSnapshot }
	| { type: 'local_stream_not_found' }
	| { type: 'local_stream_completed' }
	| { type: 'local_stream_failed'; error: Error };

export type AgentReducerEvent = AgentConversationUpdate | LocalAgentEvent;

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
		case 'local_connecting':
			return state.status === 'error'
				? state
				: { ...state, status: 'connecting', error: event.error };
		case 'local_history':
			return mergeConversation(state, createAgentConversationState(event.snapshot), true);
		case 'local_stream_not_found':
			return state.pendingSends.length === 0
				? { ...state, messages: [], status: 'idle', historyReady: true, error: undefined }
				: { ...state, status: 'submitted', historyReady: true, error: undefined };
		case 'local_stream_completed':
			return state.status === 'connecting'
				? converge({ ...state, status: 'idle', error: undefined })
				: state;
		case 'local_stream_failed':
			return { ...state, status: 'error', error: event.error };
		case 'conversation_reset':
			return mergeConversation(
				state,
				state.conversation
					? reduceAgentConversationUpdate(state.conversation, event)
					: createAgentConversationState(event.snapshot),
				state.historyReady,
			);
		case 'conversation_record':
			if (!state.conversation) return state;
			return mergeConversation(
				state,
				reduceAgentConversationUpdate(state.conversation, event),
				state.historyReady,
			);
	}
}

function mergeConversation(
	state: AgentState,
	conversation: AgentConversationState,
	historyReady: boolean,
): AgentState {
	return converge({ ...state, conversation, historyReady });
}

function converge(state: AgentState): AgentState {
	const conversation = state.conversation;
	if (!conversation) return state;
	const canonicalMessages = [
		...conversation.messages.map(toUiMessage),
		...conversation.data.map((part): UIMessage => ({
			id: part.id === undefined ? `data-event:${part.recordId}` : `data:${JSON.stringify([part.name, part.id])}`,
			role: 'assistant',
			parts: [
				{
					type: `data-${part.name}`,
					...(part.id === undefined ? {} : { id: part.id }),
					data: part.data,
				},
			],
		})),
	];
	let messages = canonicalMessages;
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

function toUiMessage(message: AgentConversationMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		metadata: message.metadata,
		parts: message.parts.flatMap((part): UIMessagePart[] => {
			if (part.type === 'text' || part.type === 'reasoning') {
				return [{ type: part.type, text: part.text, state: part.state }];
			}
			if (part.type === 'tool') {
				if (part.state === 'output-available') {
					return [{
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						input: part.input,
						state: 'output-available',
						output: part.output,
					}];
				}
				if (part.state === 'output-error') {
					return [{
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						input: part.input,
						state: 'output-error',
						errorText: part.errorText ?? 'Tool failed',
					}];
				}
				return [{
					type: 'dynamic-tool',
					toolName: part.toolName,
					toolCallId: part.toolCallId,
					input: part.input,
					state: 'input-available',
				}];
			}
			return [{
				type: 'data-attachment',
				id: part.attachment.id,
				data: {
					mediaType: part.attachment.mimeType,
					size: part.attachment.size,
					digest: part.attachment.digest,
				},
			}];
		}),
	};
}

function optimisticMessage(
	event: Extract<LocalAgentEvent, { type: 'local_send_submitted' }>,
): UIMessage {
	return {
		id: event.localId,
		role: 'user',
		parts: [
			{ type: 'text', text: event.message, state: 'done' },
			...(event.images ?? []).map((image) => ({
				type: 'file' as const,
				mediaType: image.mimeType,
				url: image.data.startsWith('data:')
					? image.data
					: `data:${image.mimeType};base64,${image.data}`,
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
