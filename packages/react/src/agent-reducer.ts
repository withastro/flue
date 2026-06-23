import {
	type AgentPromptImage,
	type AttachedAgentEvent,
	IMAGE_DATA_OMITTED,
	type LlmMessage,
	type PromptUsage,
} from '@flue/sdk';
import type { UIMessage, UIMessagePart } from './types.ts';

export type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

export interface AgentSnapshot {
	messages: UIMessage[];
	status: AgentStatus;
	error: Error | undefined;
}

interface PendingSend {
	localId: string;
	submissionId?: string;
}

export interface AgentState extends AgentSnapshot {
	pendingSends: PendingSend[];
	activeSubmissionIds: string[];
	settledSubmissionIds: string[];
	recentEventIds: string[];
	reasoningPartIndexes: Record<string, Record<number, number>>;
}

type StreamAgentEvent = AttachedAgentEvent & { submissionId?: string };

type LocalAgentEvent =
	| { type: 'local_send_submitted'; localId: string; message: string; images?: AgentPromptImage[] }
	| { type: 'local_send_admitted'; localId: string; submissionId: string }
	| { type: 'local_send_failed'; localId: string; error: Error }
	| { type: 'local_connecting'; error?: Error }
	| { type: 'local_stream_not_found' }
	| { type: 'local_stream_failed'; error: Error };

export type AgentReducerEvent = StreamAgentEvent | LocalAgentEvent;

export const emptyAgentState: AgentState = {
	messages: [],
	status: 'idle',
	error: undefined,
	pendingSends: [],
	activeSubmissionIds: [],
	settledSubmissionIds: [],
	recentEventIds: [],
	reasoningPartIndexes: {},
};

const RECENT_EVENT_LIMIT = 1000;

export function reduceAgentEvent(state: AgentState, event: AgentReducerEvent): AgentState {
	if (!('eventIndex' in event)) return reduceAgentEventOnce(state, event);
	const id = streamEventId(event);
	if (state.recentEventIds.includes(id)) return state;
	const next = reduceAgentEventOnce(state, event);
	if (next === state) return state;
	return {
		...next,
		recentEventIds: [...state.recentEventIds, id].slice(-RECENT_EVENT_LIMIT),
	};
}

function reduceAgentEventOnce(state: AgentState, event: AgentReducerEvent): AgentState {
	switch (event.type) {
		case 'local_send_submitted':
			return {
				...state,
				messages: [...state.messages, optimisticMessage(event)],
				status: 'submitted',
				error: undefined,
				pendingSends: [...state.pendingSends, { localId: event.localId }],
			};
		case 'local_send_admitted': {
			const echoId = userMessageId(event.submissionId);
			const hasEcho = state.messages.some((message) => message.id === echoId);
			const settled = state.settledSubmissionIds.includes(event.submissionId);
			const active = state.activeSubmissionIds.includes(event.submissionId);
			return {
				...state,
				messages: hasEcho
					? state.messages.filter((message) => message.id !== event.localId)
					: state.messages,
				status: active
					? 'streaming'
					: settled
						? statusWithout(event.localId, state.pendingSends)
						: state.status,
				pendingSends: settled
					? state.pendingSends.filter((send) => send.localId !== event.localId)
					: state.pendingSends.map((send) =>
							send.localId === event.localId ? { ...send, submissionId: event.submissionId } : send,
						),
			};
		}
		case 'local_send_failed':
			return {
				...state,
				messages: state.messages.filter((message) => message.id !== event.localId),
				status: 'error',
				error: event.error,
				pendingSends: state.pendingSends.filter((send) => send.localId !== event.localId),
			};
		case 'local_connecting':
			return { ...state, status: 'connecting', error: event.error };
		case 'local_stream_not_found':
			return state.pendingSends.length === 0
				? { ...state, messages: [], status: 'idle', error: undefined }
				: { ...state, status: 'submitted', error: undefined };
		case 'local_stream_failed':
			return { ...state, status: 'error', error: event.error };
		case 'message_start':
			return reduceMessageBoundary(state, event);
		case 'text_delta':
			return reduceTextDelta(state, event);
		case 'thinking_start':
			return reduceThinkingStart(state, event);
		case 'thinking_delta':
			return reduceThinkingDelta(state, event);
		case 'thinking_end':
			return reduceThinkingEnd(state, event);
		case 'message_end':
			return reduceMessageBoundary(state, event);
		case 'tool_start':
			return reduceToolStart(state, event);
		case 'tool':
			return reduceToolResult(state, event);
		case 'turn':
			return reduceTurn(state, event);
		case 'submission_settled':
			return event.outcome === 'failed' &&
				state.pendingSends.some((send) => send.submissionId === event.submissionId)
				? {
						...state,
						status: 'error',
						error: new Error(event.error?.message ?? 'Agent submission failed'),
						pendingSends: state.pendingSends.filter(
							(send) => send.submissionId !== event.submissionId,
						),
					}
				: state;
		case 'idle': {
			const pendingSends = event.submissionId
				? state.pendingSends.filter((send) => send.submissionId !== event.submissionId)
				: state.pendingSends;
			return {
				...state,
				status: state.status === 'error' ? 'error' : pendingSends.length > 0 ? 'submitted' : 'idle',
				error: state.status === 'error' ? state.error : undefined,
				pendingSends,
				activeSubmissionIds: event.submissionId
					? state.activeSubmissionIds.filter((id) => id !== event.submissionId)
					: state.activeSubmissionIds,
				settledSubmissionIds: event.submissionId
					? addUnique(state.settledSubmissionIds, event.submissionId)
					: state.settledSubmissionIds,
			};
		}
		default:
			return state;
	}
}

function reduceMessageBoundary(
	state: AgentState,
	event: StreamAgentEvent & { message: LlmMessage },
): AgentState {
	if (event.message.role === 'toolResult') return state;
	const id = messageId(event, event.message.role);
	const existing = state.messages.find((message) => message.id === id);
	const local = event.submissionId
		? state.pendingSends.find((send) => send.submissionId === event.submissionId)
		: undefined;
	const optimistic = local
		? state.messages.find((message) => message.id === local.localId)
		: undefined;
	const message = snapshotMessage(
		id,
		event.message,
		event.type === 'message_end',
		optimistic ?? existing,
	);
	let messages = replaceById(state.messages, id, message);
	if (local) messages = messages.filter((item) => item.id !== local.localId);
	const ownAssistant =
		event.message.role === 'assistant' &&
		event.submissionId !== undefined &&
		state.pendingSends.some((send) => send.submissionId === event.submissionId);
	return {
		...state,
		messages,
		status: ownAssistant ? 'streaming' : state.status,
		activeSubmissionIds:
			event.message.role === 'assistant' && event.submissionId
				? addUnique(state.activeSubmissionIds, event.submissionId)
				: state.activeSubmissionIds,
		reasoningPartIndexes: event.message.role === 'assistant'
			? { ...state.reasoningPartIndexes, [id]: reasoningIndexes(event.message) }
			: state.reasoningPartIndexes,
	};
}

function reduceTextDelta(
	state: AgentState,
	event: StreamAgentEvent & { text: string },
): AgentState {
	const index = findEventAssistant(state.messages, event);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const parts = [...current.parts];
	const last = parts.at(-1);
	if (last?.type === 'text' && last.state !== 'done') {
		parts[parts.length - 1] = { ...last, text: last.text + event.text, state: 'streaming' };
	} else {
		parts.push({ type: 'text', text: event.text, state: 'streaming' });
	}
	return replaceMessageAt(state, index, { ...current, parts });
}

function reduceThinkingStart(
	state: AgentState,
	event: StreamAgentEvent & { contentIndex?: number },
): AgentState {
	const index = findEventAssistant(state.messages, event);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const known = event.contentIndex === undefined
		? undefined
		: state.reasoningPartIndexes[current.id]?.[event.contentIndex];
	if (known !== undefined && current.parts[known]?.type === 'reasoning') return state;
	const partIndex = current.parts.length;
	const next = replaceMessageAt(state, index, {
		...current,
		parts: [...current.parts, { type: 'reasoning', text: '', state: 'streaming' }],
	});
	return event.contentIndex === undefined
		? next
		: {
				...next,
				reasoningPartIndexes: setReasoningPartIndex(
					state.reasoningPartIndexes,
					current.id,
					event.contentIndex,
					partIndex,
				),
			};
}

function reduceThinkingDelta(
	state: AgentState,
	event: StreamAgentEvent & { contentIndex?: number; delta: string },
): AgentState {
	const index = findEventAssistant(state.messages, event);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const reasoning = event.contentIndex === undefined
		? current.parts.findLastIndex((part) => part.type === 'reasoning' && part.state !== 'done')
		: state.reasoningPartIndexes[current.id]?.[event.contentIndex];
	if (reasoning === undefined || reasoning < 0) return state;
	const part = current.parts[reasoning];
	if (!part || part.type !== 'reasoning' || part.state === 'done') return state;
	const parts = [...current.parts];
	parts[reasoning] = { ...part, text: part.text + event.delta, state: 'streaming' };
	return replaceMessageAt(state, index, { ...current, parts });
}

function reduceThinkingEnd(
	state: AgentState,
	event: StreamAgentEvent & { contentIndex?: number; content: string },
): AgentState {
	const index = findEventAssistant(state.messages, event);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const reasoning = event.contentIndex === undefined
		? current.parts.findLastIndex((part) => part.type === 'reasoning')
		: state.reasoningPartIndexes[current.id]?.[event.contentIndex];
	if (reasoning === undefined || reasoning < 0) return state;
	const part = current.parts[reasoning];
	if (!part || part.type !== 'reasoning') return state;
	const parts = [...current.parts];
	parts[reasoning] = { ...part, text: event.content, state: 'done' };
	return replaceMessageAt(state, index, { ...current, parts });
}

function reduceToolStart(
	state: AgentState,
	event: StreamAgentEvent & { toolName: string; toolCallId: string; args?: unknown },
): AgentState {
	let messages = state.messages;
	let index = findToolMessage(messages, event.toolCallId);
	if (index < 0 && event.turnId) {
		const id = `turn:${event.turnId}`;
		index = messages.findIndex((message) => message.id === id);
		if (index < 0) {
			messages = [...messages, { id, role: 'assistant', metadata: undefined, parts: [] }];
			index = messages.length - 1;
		}
	}
	if (index < 0) return state;
	const current = messages[index];
	if (!current) return state;
	const exists = current.parts.some(
		(part) => part.type === 'dynamic-tool' && part.toolCallId === event.toolCallId,
	);
	const parts: UIMessagePart[] = exists
		? current.parts.map(
				(part): UIMessagePart =>
					part.type === 'dynamic-tool' && part.toolCallId === event.toolCallId
						? {
								type: 'dynamic-tool',
								toolName: event.toolName,
								toolCallId: part.toolCallId,
								input: event.args ?? part.input,
								state: 'input-available',
							}
						: part,
			)
		: [
				...current.parts,
				{
					type: 'dynamic-tool' as const,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					state: 'input-available' as const,
					input: event.args,
				},
			];
	return replaceMessageAt({ ...state, messages }, index, { ...current, parts });
}

function reduceToolResult(
	state: AgentState,
	event: StreamAgentEvent & {
		toolName: string;
		toolCallId: string;
		isError: boolean;
		result?: unknown;
	},
): AgentState {
	const index = findToolMessage(state.messages, event.toolCallId);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const parts = current.parts.map((part) => {
		if (part.type !== 'dynamic-tool' || part.toolCallId !== event.toolCallId) return part;
		return event.isError
			? {
					...part,
					state: 'output-error' as const,
					output: undefined,
					errorText: errorText(event.result),
				}
			: { ...part, state: 'output-available' as const, output: event.result, errorText: undefined };
	});
	return replaceMessageAt(state, index, { ...current, parts });
}

function reduceTurn(
	state: AgentState,
	event: StreamAgentEvent & {
		turnId: string;
		usage?: PromptUsage;
		model?: string;
		provider?: string;
	},
): AgentState {
	let index = state.messages.findIndex((message) => message.id === `turn:${event.turnId}`);
	if (index < 0) index = findLastAssistant(state.messages);
	if (index < 0) return state;
	const current = state.messages[index];
	if (!current) return state;
	const metadata = {
		...current.metadata,
		...(event.usage ? { usage: event.usage } : {}),
		...(event.model && event.provider
			? { model: { provider: event.provider, id: event.model } }
			: {}),
	};
	return replaceMessageAt(state, index, { ...current, metadata });
}

function snapshotMessage(
	id: string,
	message: Exclude<LlmMessage, { role: 'toolResult' }>,
	done: boolean,
	previous?: UIMessage,
): UIMessage {
	const parts: UIMessagePart[] = [];
	let previousFileIndex = 0;
	const previousFiles = previous?.parts.filter((part) => part.type === 'file') ?? [];
	const content =
		typeof message.content === 'string'
			? [{ type: 'text' as const, text: message.content }]
			: message.content;
	for (const block of content) {
		if (block.type === 'text')
			parts.push({ type: 'text', text: block.text, state: done ? 'done' : 'streaming' });
		if (block.type === 'thinking') {
			parts.push({ type: 'reasoning', text: block.thinking, state: done ? 'done' : 'streaming' });
		}
		if (block.type === 'toolCall') {
			const prior = previous?.parts.find(
				(part) => part.type === 'dynamic-tool' && part.toolCallId === block.id,
			);
			parts.push(
				prior ?? {
					type: 'dynamic-tool',
					toolName: block.name,
					toolCallId: block.id,
					state: 'input-available',
					input: block.arguments,
				},
			);
		}
		if (block.type === 'image') {
			const prior = previousFiles[previousFileIndex++];
			parts.push(
				block.data === IMAGE_DATA_OMITTED && prior?.mediaType === block.mimeType
					? prior
					: { type: 'file', mediaType: block.mimeType, url: imageUrl(block.data, block.mimeType) },
			);
		}
	}
	return { id, role: message.role, metadata: previous?.metadata, parts };
}

function reasoningIndexes(message: LlmMessage): Record<number, number> {
	if (message.role !== 'assistant' || typeof message.content === 'string') return {};
	const indexes: Record<number, number> = {};
	let partIndex = 0;
	for (const [contentIndex, block] of message.content.entries()) {
		if (block.type === 'thinking') indexes[contentIndex] = partIndex;
		partIndex++;
	}
	return indexes;
}

function setReasoningPartIndex(
	indexes: AgentState['reasoningPartIndexes'],
	messageId: string,
	contentIndex: number,
	partIndex: number,
): AgentState['reasoningPartIndexes'] {
	return {
		...indexes,
		[messageId]: { ...indexes[messageId], [contentIndex]: partIndex },
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
				url: imageUrl(image.data, image.mimeType),
			})),
		],
	};
}

function streamEventId(event: StreamAgentEvent): string {
	const contextId = event.dispatchId ?? event.submissionId;
	return contextId
		? `${event.instanceId}:${contextId}:${event.timestamp}:${event.eventIndex}`
		: `${event.instanceId}:${event.timestamp}:${event.eventIndex}`;
}

function messageId(event: StreamAgentEvent, role: 'user' | 'assistant'): string {
	if (role === 'assistant' && event.turnId) return `turn:${event.turnId}`;
	if (role === 'user' && event.submissionId) return userMessageId(event.submissionId);
	return `event:${event.timestamp}:${event.eventIndex}:${role}`;
}

function userMessageId(submissionId: string): string {
	return `submission:${submissionId}:user:0`;
}

function imageUrl(data: string, mimeType: string): string {
	return data === IMAGE_DATA_OMITTED
		? data
		: data.startsWith('data:')
			? data
			: `data:${mimeType};base64,${data}`;
}

function replaceById(messages: UIMessage[], id: string, message: UIMessage): UIMessage[] {
	const index = messages.findIndex((item) => item.id === id);
	if (index < 0) return [...messages, message];
	const next = [...messages];
	next[index] = message;
	return next;
}

function replaceMessageAt(state: AgentState, index: number, message: UIMessage): AgentState {
	const messages = [...state.messages];
	messages[index] = message;
	return { ...state, messages };
}

function findToolMessage(messages: UIMessage[], toolCallId: string): number {
	return messages.findIndex((message) =>
		message.parts.some((part) => part.type === 'dynamic-tool' && part.toolCallId === toolCallId),
	);
}

function findEventAssistant(messages: UIMessage[], event: StreamAgentEvent): number {
	return event.turnId
		? messages.findIndex((message) => message.id === `turn:${event.turnId}`)
		: findLastAssistant(messages);
}

function findLastAssistant(messages: UIMessage[]): number {
	return messages.findLastIndex((message) => message.role === 'assistant');
}

function statusWithout(localId: string, pendingSends: PendingSend[]): AgentStatus {
	return pendingSends.some((send) => send.localId !== localId) ? 'submitted' : 'idle';
}

function addUnique(values: string[], value: string): string[] {
	return values.includes(value) ? values : [...values, value];
}

function errorText(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	return JSON.stringify(value) ?? String(value);
}
