import type { BackoffOptions, LiveMode } from '@durable-streams/client';
import type { PromptUsage } from '../types.ts';

export interface AgentConversationSelector {
	conversationId?: string;
	harness?: string;
	session?: string;
}

export interface AgentConversationDeltaState {
	nextSequence: number;
	accepted: string[];
}

export type AgentConversationPart =
	| {
			type: 'text';
			blockId?: string;
			text: string;
			state: 'streaming' | 'done';
			deltaState?: AgentConversationDeltaState;
	  }
	| {
			type: 'reasoning';
			blockId?: string;
			text: string;
			state: 'streaming' | 'done';
			deltaState?: AgentConversationDeltaState;
	  }
	| {
			type: 'attachment';
			attachment: { id: string; mimeType: string; size: number; digest: string };
	  }
	| {
			type: 'tool';
			toolCallId: string;
			toolName: string;
			input: unknown;
			state: 'input-available' | 'output-available' | 'output-error';
			output?: unknown;
			errorText?: string;
	  };

export interface AgentConversationMessage {
	id: string;
	role: 'user' | 'assistant';
	submissionId?: string;
	parts: AgentConversationPart[];
	metadata?: {
		usage?: PromptUsage;
		model?: { provider: string; id: string };
	};
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
	messages: AgentConversationMessage[];
	data: AgentConversationDataPart[];
	settlements: AgentConversationSettlement[];
}

export interface CanonicalConversationRecord {
	v: 1;
	id: string;
	type: string;
	conversationId: string;
	harness: string;
	session: string;
	timestamp: string;
	submissionId?: string;
	turnId?: string;
	[key: string]: unknown;
}

export type AgentConversationUpdate =
	| {
			v: 1;
			type: 'conversation_record';
			conversationId: string;
			record: CanonicalConversationRecord;
	  }
	| {
			v: 1;
			type: 'conversation_reset';
			conversationId: string;
			snapshot: AgentConversationSnapshot;
	  };

export interface AgentConversationHistoryOptions extends AgentConversationSelector {
	signal?: AbortSignal;
}

export interface AgentConversationUpdateOptions extends AgentConversationSelector {
	offset: string;
	live?: LiveMode;
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
}

export interface AgentConversationActivity {
	v: 1;
	type: 'conversation_activity';
	record: CanonicalConversationRecord;
}

export type AgentConversationActivityOptions = AgentConversationUpdateOptions;

export interface AgentConversationState {
	conversationId: string;
	messages: AgentConversationMessage[];
	data: AgentConversationDataPart[];
	settlements: AgentConversationSettlement[];
	recordIds: string[];
}

export function assertAgentConversationUpdate(
	value: AgentConversationUpdate,
): AgentConversationUpdate {
	if (
		!value ||
		typeof value !== 'object' ||
		value.v !== 1 ||
		(value.type !== 'conversation_record' && value.type !== 'conversation_reset')
	) {
		throw new TypeError('Unsupported agent conversation update.');
	}
	return value;
}

export function createAgentConversationState(
	snapshot: AgentConversationSnapshot,
): AgentConversationState {
	return {
		conversationId: snapshot.conversationId,
		messages: snapshot.messages,
		data: snapshot.data,
		settlements: snapshot.settlements,
		recordIds: [],
	};
}

export function reduceAgentConversationUpdate(
	state: AgentConversationState,
	update: AgentConversationUpdate,
): AgentConversationState {
	if (update.type === 'conversation_reset') return createAgentConversationState(update.snapshot);
	if (update.conversationId !== state.conversationId) return state;
	return reduceRecord(state, update.record);
}

function reduceRecord(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
): AgentConversationState {
	switch (record.type) {
		case 'user_message': {
			const parts = Array.isArray(record.content)
				? record.content.flatMap((part): AgentConversationPart[] => {
						if (!part || typeof part !== 'object') return [];
						if ('type' in part && part.type === 'text' && 'text' in part) {
							return [{ type: 'text', text: String(part.text), state: 'done' }];
						}
						if ('type' in part && part.type === 'attachment' && 'attachment' in part) {
							return [{ type: 'attachment', attachment: part.attachment as Extract<AgentConversationPart, { type: 'attachment' }>['attachment'] }];
						}
						return [];
					})
				: [];
		return replaceMessage(state, {
			id: String(record.messageId),
			role: 'user',
			...(record.submissionId ? { submissionId: record.submissionId } : {}),
			parts,
		});
		}
		case 'signal':
			return replaceMessage(state, {
				id: String(record.messageId),
				role: 'user',
				parts: [{ type: 'text', text: String(record.content ?? ''), state: 'done' }],
			});
		case 'assistant_message_started': {
			if (state.messages.some((message) => message.id === String(record.messageId))) return state;
			const modelInfo = record.modelInfo as { provider?: unknown; model?: unknown } | undefined;
			return replaceMessage(state, {
				id: String(record.messageId),
				role: 'assistant',
				...(record.submissionId ? { submissionId: record.submissionId } : {}),
				parts: [],
				...(typeof modelInfo?.provider === 'string' && typeof modelInfo.model === 'string'
					? { metadata: { model: { provider: modelInfo.provider, id: modelInfo.model } } }
					: {}),
			});
		}
		case 'assistant_text_started':
			return upsertBlock(state, record, {
				type: 'text',
				blockId: String(record.blockId),
				text: '',
				state: 'streaming',
			});
		case 'assistant_reasoning_started':
			return upsertBlock(state, record, {
				type: 'reasoning',
				blockId: String(record.blockId),
				text: '',
				state: 'streaming',
			});
		case 'assistant_text_delta':
			return appendBlockDelta(state, record, 'text');
		case 'assistant_reasoning_delta':
			return appendBlockDelta(state, record, 'reasoning');
		case 'assistant_text_completed':
			return completeBlock(state, record, 'text');
		case 'assistant_reasoning_completed':
			return completeBlock(state, record, 'reasoning');
		case 'assistant_tool_call':
			return upsertBlock(state, record, {
				type: 'tool',
				toolCallId: String(record.toolCallId),
				toolName: String(record.name),
				input: record.arguments,
				state: 'input-available',
			});
		case 'assistant_message_completed':
			return updateMessage(state, String(record.messageId), (message) => ({
				...message,
				parts: message.parts.map((part) =>
					part.type === 'text' || part.type === 'reasoning' ? { ...part, state: 'done' } : part,
				),
				metadata: {
					...message.metadata,
					...(record.usage ? { usage: record.usage as PromptUsage } : {}),
				},
			}));
		case 'tool_result':
			return updateToolResult(state, record);
		case 'data':
			return updateData(state, record);
		case 'submission_settled':
			return updateSettlement(state, record);
		default:
			return state;
	}
}

function replaceMessage(
	state: AgentConversationState,
	message: AgentConversationMessage,
): AgentConversationState {
	const index = state.messages.findIndex((value) => value.id === message.id);
	if (index < 0) return { ...state, messages: [...state.messages, message] };
	const messages = [...state.messages];
	messages[index] = message;
	return { ...state, messages };
}

function updateMessage(
	state: AgentConversationState,
	messageId: string,
	update: (message: AgentConversationMessage) => AgentConversationMessage,
): AgentConversationState {
	const index = state.messages.findIndex((message) => message.id === messageId);
	if (index < 0) return state;
	const messages = [...state.messages];
	messages[index] = update(messages[index] as AgentConversationMessage);
	return { ...state, messages };
}

function upsertBlock(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
	part: AgentConversationPart,
): AgentConversationState {
	return updateMessage(state, String(record.messageId), (message) => {
		const blockIndex = Number(record.blockIndex);
		const existing = message.parts.find((value) => blockIdentity(value) === blockIdentity(part));
		if (existing) return message;
		const parts = [...message.parts];
		parts[blockIndex] = part;
		return { ...message, parts };
	});
}

function blockIdentity(part: AgentConversationPart): string | undefined {
	if (part.type === 'text' || part.type === 'reasoning') return `${part.type}:${part.blockId}`;
	if (part.type === 'tool') return `tool:${part.toolCallId}`;
	return undefined;
}

function appendBlockDelta(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
	type: 'text' | 'reasoning',
): AgentConversationState {
	return updateMessage(state, String(record.messageId), (message) => {
		const blockIndex = message.parts.findIndex(
			(part) => part.type === type && part.blockId === record.blockId,
		);
		if (blockIndex < 0) return message;
		const sequence = Number(record.sequence);
		const delta = String(record.delta ?? '');
		if (!Number.isInteger(sequence) || sequence < 0) {
			throw new Error(`Invalid delta sequence ${String(record.sequence)} for block "${String(record.blockId)}".`);
		}
		const parts = [...message.parts];
		const part = parts[blockIndex] as Extract<AgentConversationPart, { type: typeof type }>;
		const deltaState = part.deltaState ?? { nextSequence: 0, accepted: [] };
		if (sequence < deltaState.nextSequence) {
			if (deltaState.accepted[sequence] === delta) return message;
			throw new Error(`Conflicting replay for delta sequence ${sequence} on block "${String(record.blockId)}".`);
		}
		if (sequence > deltaState.nextSequence) {
			throw new Error(`Expected delta sequence ${deltaState.nextSequence}, received ${sequence} for block "${String(record.blockId)}".`);
		}
		parts[blockIndex] = {
			...part,
			text: part.text + delta,
			deltaState: {
				nextSequence: deltaState.nextSequence + 1,
				accepted: [...deltaState.accepted, delta],
			},
		};
		return { ...message, parts };
	});
}

function completeBlock(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
	type: 'text' | 'reasoning',
): AgentConversationState {
	return updateMessage(state, String(record.messageId), (message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (part.type !== type || part.blockId !== record.blockId) return part;
			const deltaCount = Number(record.deltaCount);
			const acceptedCount = part.deltaState?.nextSequence ?? 0;
			if (!Number.isInteger(deltaCount) || deltaCount !== acceptedCount) {
				throw new Error(`Expected ${deltaCount} deltas for block "${String(record.blockId)}", received ${acceptedCount}.`);
			}
			return { ...part, state: 'done' };
		}),
	}));
}

function updateToolResult(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
): AgentConversationState {
	const toolCallId = String(record.toolCallId);
	const index = state.messages.findLastIndex((message) =>
		message.parts.some((part) => part.type === 'tool' && part.toolCallId === toolCallId),
	);
	if (index < 0) return state;
	const messages = [...state.messages];
	const message = messages[index] as AgentConversationMessage;
	const output = toolResultOutput(record.content);
	messages[index] = {
		...message,
		parts: message.parts.map((part) =>
			part.type !== 'tool' || part.toolCallId !== toolCallId
				? part
				: record.isError
					? { ...part, state: 'output-error', errorText: String(output), output: undefined }
					: { ...part, state: 'output-available', output, errorText: undefined },
		),
	};
	return { ...state, messages };
}

function updateData(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
): AgentConversationState {
	const id = typeof record.dataId === 'string' ? record.dataId : undefined;
	const name = String(record.dataType);
	const key = id === undefined ? record.id : JSON.stringify([name, id]);
	const index = state.data.findIndex((part) =>
		(part.id === undefined ? part.recordId : JSON.stringify([part.name, part.id])) === key,
	);
	const part = { recordId: record.id, name, ...(id === undefined ? {} : { id }), data: record.data };
	if (index < 0) return { ...state, data: [...state.data, part] };
	const data = [...state.data];
	data[index] = part;
	return { ...state, data };
}

function updateSettlement(
	state: AgentConversationState,
	record: CanonicalConversationRecord,
): AgentConversationState {
	if (typeof record.submissionId !== 'string') return state;
	const settlement: AgentConversationSettlement = {
		recordId: record.id,
		submissionId: record.submissionId,
		outcome: record.outcome === 'failed' ? 'failed' : 'completed',
		...(record.result === undefined ? {} : { result: record.result }),
		...(record.error === undefined ? {} : { error: record.error }),
	};
	const index = state.settlements.findIndex((value) => value.submissionId === settlement.submissionId);
	if (index < 0) return { ...state, settlements: [...state.settlements, settlement] };
	const settlements = [...state.settlements];
	settlements[index] = settlement;
	return { ...state, settlements };
}

function toolResultOutput(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	if (value.length === 1) {
		const block = value[0];
		if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
			return block.text;
		}
	}
	return value;
}
