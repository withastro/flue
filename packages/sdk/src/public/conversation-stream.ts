import type { PromptUsage } from '../types.ts';
import type {
	FlueConversationMessage,
	FlueConversationPart,
	FlueConversationSettlement,
	FlueConversationSnapshot,
	FlueConversationState,
} from './conversation.ts';

/**
 * Internal UI projection protocol carried by the agent conversation `updates`
 * view. These chunks are NOT public API: the runtime projects its private
 * canonical conversation log into this strict, UI-only union, and `observe()`
 * reduces it into {@link FlueConversationState}. Application code never sees a
 * chunk — it consumes materialized messages.
 *
 * The shape intentionally excludes canonical persistence vocabulary (record
 * names, harness/session/turn/attempt identifiers, physical offsets) so the
 * canonical schema can evolve without changing this wire contract.
 */
export type ConversationStreamChunk =
	| { type: 'conversation-reset'; conversationId: string; snapshot: FlueConversationSnapshot }
	| { type: 'message-appended'; conversationId: string; message: FlueConversationMessage }
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
	| {
			type: 'part-end';
			conversationId: string;
			messageId: string;
			partId: string;
	  }
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

/**
 * Thrown by the reducer when an incremental chunk cannot be applied to the
 * current state (an unknown chunk shape, or a delta sequence gap that implies
 * missing data). `observe()` recovers by rehydrating a fresh snapshot.
 */
export class ConversationStreamError extends Error {
	readonly recover: 'rehydrate';
	constructor(message: string) {
		super(message);
		this.name = 'ConversationStreamError';
		this.recover = 'rehydrate';
	}
}

/**
 * Private streaming-assembly state. Holds the public conversation plus the
 * bookkeeping needed to apply incremental chunks idempotently — part locations
 * and per-part next-delta sequence counters. None of this leaks into
 * {@link FlueConversationState}.
 */
export interface ConversationStreamState {
	conversation: FlueConversationState;
	/** `${messageId}\u0000${partId}` -> position of the streaming part. */
	partLocations: Map<string, { messageIndex: number; partIndex: number }>;
	/** `${messageId}\u0000${partId}` -> next expected delta sequence. */
	partSequences: Map<string, number>;
}

const CHUNK_TYPES = new Set<ConversationStreamChunk['type']>([
	'conversation-reset',
	'message-appended',
	'message-started',
	'part-start',
	'part-delta',
	'part-end',
	'tool-input',
	'tool-output',
	'tool-output-error',
	'message-completed',
	'submission-settled',
]);

/**
 * Validates one conversation stream chunk read from the `updates` view. Rejects
 * unknown shapes so a protocol mismatch fails loudly instead of silently
 * producing incomplete state.
 */
export function assertConversationStreamChunk(value: ConversationStreamChunk): ConversationStreamChunk {
	if (
		!value ||
		typeof value !== 'object' ||
		typeof (value as { type?: unknown }).type !== 'string' ||
		!CHUNK_TYPES.has((value as ConversationStreamChunk).type) ||
		typeof (value as { conversationId?: unknown }).conversationId !== 'string'
	) {
		throw new ConversationStreamError(
			`Unsupported agent conversation chunk: ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

export function createConversationStreamState(
	snapshot: FlueConversationSnapshot,
): ConversationStreamState {
	return {
		conversation: {
			conversationId: snapshot.conversationId,
			messages: snapshot.messages,
			settlements: snapshot.settlements,
		},
		partLocations: new Map(),
		partSequences: new Map(),
	};
}

function partKey(messageId: string, partId: string): string {
	return `${messageId}\u0000${partId}`;
}

export function applyConversationChunk(
	state: ConversationStreamState,
	chunk: ConversationStreamChunk,
): ConversationStreamState {
	switch (chunk.type) {
		case 'conversation-reset':
			return createConversationStreamState(chunk.snapshot);
		case 'message-appended':
			return mutateMessages(state, (messages) => upsertMessage(messages, chunk.message));
		case 'message-started':
			return mutateMessages(state, (messages) => {
				if (messages.some((message) => message.id === chunk.messageId)) return messages;
				return [
					...messages,
					{
						id: chunk.messageId,
						role: 'assistant',
						...(chunk.submissionId ? { submissionId: chunk.submissionId } : {}),
						parts: [],
						...(chunk.model ? { metadata: { model: chunk.model } } : {}),
					},
				];
			});
		case 'part-start':
			return startPart(state, chunk.messageId, chunk.partId, chunk.kind);
		case 'part-delta':
			return appendPartDelta(state, chunk);
		case 'part-end':
			return endPart(state, chunk.messageId, chunk.partId);
		case 'tool-input':
			return appendToolInput(state, chunk);
		case 'tool-output':
			return applyToolResult(state, chunk.toolCallId, (part) => ({
				...part,
				state: 'output-available',
				output: chunk.output,
				errorText: undefined,
			}));
		case 'tool-output-error':
			return applyToolResult(state, chunk.toolCallId, (part) => ({
				...part,
				state: 'output-error',
				output: undefined,
				errorText: chunk.errorText,
			}));
		case 'message-completed':
			return completeMessage(state, chunk.messageId, chunk.usage);
		case 'submission-settled':
			return applySettlement(state, chunk);
		default: {
			const unknown = chunk as { type?: unknown };
			throw new ConversationStreamError(
				`Unsupported conversation chunk type "${String(unknown.type)}".`,
			);
		}
	}
}

function mutateMessages(
	state: ConversationStreamState,
	update: (messages: FlueConversationMessage[]) => FlueConversationMessage[],
): ConversationStreamState {
	const messages = update(state.conversation.messages);
	if (messages === state.conversation.messages) return state;
	return { ...state, conversation: { ...state.conversation, messages } };
}

function upsertMessage(
	messages: FlueConversationMessage[],
	message: FlueConversationMessage,
): FlueConversationMessage[] {
	const index = messages.findIndex((value) => value.id === message.id);
	if (index < 0) return [...messages, message];
	const next = [...messages];
	next[index] = message;
	return next;
}

function startPart(
	state: ConversationStreamState,
	messageId: string,
	partId: string,
	kind: 'text' | 'reasoning',
): ConversationStreamState {
	const key = partKey(messageId, partId);
	if (state.partLocations.has(key)) return state;
	const messageIndex = state.conversation.messages.findIndex((message) => message.id === messageId);
	if (messageIndex < 0) return state;
	const message = state.conversation.messages[messageIndex] as FlueConversationMessage;
	const part: FlueConversationPart = { type: kind, text: '', state: 'streaming' };
	const messages = replacePart(state.conversation.messages, messageIndex, [...message.parts, part]);
	const partLocations = new Map(state.partLocations);
	partLocations.set(key, { messageIndex, partIndex: message.parts.length });
	const partSequences = new Map(state.partSequences);
	partSequences.set(key, 0);
	return { conversation: { ...state.conversation, messages }, partLocations, partSequences };
}

function appendPartDelta(
	state: ConversationStreamState,
	chunk: Extract<ConversationStreamChunk, { type: 'part-delta' }>,
): ConversationStreamState {
	const key = partKey(chunk.messageId, chunk.partId);
	const location = state.partLocations.get(key) ?? claimStreamingPart(state, chunk);
	if (!location) return state;
	const expected = state.partSequences.get(key) ?? chunk.sequence;
	if (chunk.sequence < expected) return state; // idempotent replay
	if (chunk.sequence > expected) {
		throw new ConversationStreamError(
			`Conversation delta gap on part "${chunk.partId}": expected ${expected}, received ${chunk.sequence}.`,
		);
	}
	const message = state.conversation.messages[location.messageIndex] as FlueConversationMessage;
	const existing = message.parts[location.partIndex];
	const parts = [...message.parts];
	if (!existing) {
		// Claimed a fresh tail slot for a post-reset block whose `part-start`
		// preceded the snapshot and was not materialized. Create it so the delta
		// is rendered rather than silently dropped.
		parts[location.partIndex] = { type: chunk.kind, text: chunk.delta, state: 'streaming' };
	} else if (existing.type !== 'text' && existing.type !== 'reasoning') {
		return state;
	} else {
		parts[location.partIndex] = { ...existing, text: existing.text + chunk.delta };
	}
	const messages = replacePart(state.conversation.messages, location.messageIndex, parts);
	const partLocations = state.partLocations.has(key)
		? state.partLocations
		: new Map(state.partLocations).set(key, location);
	const partSequences = new Map(state.partSequences);
	partSequences.set(key, chunk.sequence + 1);
	return { conversation: { ...state.conversation, messages }, partLocations, partSequences };
}

/**
 * Locate the streaming part a delta belongs to when its partId is unknown —
 * the case immediately after a snapshot reset, where the snapshot materialized
 * an in-progress block as a clean `{ type, text, state: 'streaming' }` part with
 * no id. Claims the last unclaimed streaming part of the matching kind.
 */
function claimStreamingPart(
	state: ConversationStreamState,
	chunk: Extract<ConversationStreamChunk, { type: 'part-delta' }>,
): { messageIndex: number; partIndex: number } | undefined {
	const messageIndex = state.conversation.messages.findIndex(
		(message) => message.id === chunk.messageId,
	);
	if (messageIndex < 0) return undefined;
	const claimed = new Set(
		[...state.partLocations.values()]
			.filter((location) => location.messageIndex === messageIndex)
			.map((location) => location.partIndex),
	);
	const parts = (state.conversation.messages[messageIndex] as FlueConversationMessage).parts;
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (part && part.type === chunk.kind && part.state === 'streaming' && !claimed.has(index)) {
			return { messageIndex, partIndex: index };
		}
	}
	// No materialized streaming part to continue: point at the tail slot so
	// `appendPartDelta` creates a fresh part there instead of dropping the delta.
	const message = state.conversation.messages[messageIndex] as FlueConversationMessage;
	return { messageIndex, partIndex: message.parts.length };
}

function endPart(
	state: ConversationStreamState,
	messageId: string,
	partId: string,
): ConversationStreamState {
	const key = partKey(messageId, partId);
	const location = state.partLocations.get(key);
	if (!location) return state;
	const message = state.conversation.messages[location.messageIndex] as FlueConversationMessage;
	const existing = message.parts[location.partIndex];
	if (!existing || (existing.type !== 'text' && existing.type !== 'reasoning')) return state;
	if (existing.state === 'done') return state;
	const parts = [...message.parts];
	parts[location.partIndex] = { ...existing, state: 'done' };
	const messages = replacePart(state.conversation.messages, location.messageIndex, parts);
	return { ...state, conversation: { ...state.conversation, messages } };
}

function appendToolInput(
	state: ConversationStreamState,
	chunk: Extract<ConversationStreamChunk, { type: 'tool-input' }>,
): ConversationStreamState {
	return mutateMessages(state, (messages) => {
		const index = messages.findIndex((message) => message.id === chunk.messageId);
		if (index < 0) return messages;
		const message = messages[index] as FlueConversationMessage;
		if (message.parts.some((part) => part.type === 'dynamic-tool' && part.toolCallId === chunk.toolCallId)) {
			return messages;
		}
		const next = [...messages];
		next[index] = {
			...message,
			parts: [
				...message.parts,
				{
					type: 'dynamic-tool',
					toolName: chunk.toolName,
					toolCallId: chunk.toolCallId,
					state: 'input-available',
					input: chunk.input,
				},
			],
		};
		return next;
	});
}

function applyToolResult(
	state: ConversationStreamState,
	toolCallId: string,
	update: (
		part: Extract<FlueConversationPart, { type: 'dynamic-tool' }>,
	) => FlueConversationPart,
): ConversationStreamState {
	return mutateMessages(state, (messages) => {
		const index = messages.findLastIndex((message) =>
			message.parts.some((part) => part.type === 'dynamic-tool' && part.toolCallId === toolCallId),
		);
		if (index < 0) return messages;
		const message = messages[index] as FlueConversationMessage;
		const next = [...messages];
		next[index] = {
			...message,
			parts: message.parts.map((part) =>
				part.type === 'dynamic-tool' && part.toolCallId === toolCallId ? update(part) : part,
			),
		};
		return next;
	});
}

function completeMessage(
	state: ConversationStreamState,
	messageId: string,
	usage: PromptUsage | undefined,
): ConversationStreamState {
	return mutateMessages(state, (messages) => {
		const index = messages.findIndex((message) => message.id === messageId);
		if (index < 0) return messages;
		const message = messages[index] as FlueConversationMessage;
		const next = [...messages];
		next[index] = {
			...message,
			parts: message.parts.map((part) =>
				part.type === 'text' || part.type === 'reasoning' ? { ...part, state: 'done' } : part,
			),
			...(usage ? { metadata: { ...message.metadata, usage } } : {}),
		};
		return next;
	});
}

function applySettlement(
	state: ConversationStreamState,
	chunk: Extract<ConversationStreamChunk, { type: 'submission-settled' }>,
): ConversationStreamState {
	const settlement: FlueConversationSettlement = {
		submissionId: chunk.submissionId,
		outcome: chunk.outcome,
		...(chunk.result === undefined ? {} : { result: chunk.result }),
		...(chunk.error === undefined ? {} : { error: chunk.error }),
	};
	const settlements = state.conversation.settlements;
	const index = settlements.findIndex((value) => value.submissionId === settlement.submissionId);
	const next = index < 0 ? [...settlements, settlement] : settlements.map((value, i) => (i === index ? settlement : value));
	return { ...state, conversation: { ...state.conversation, settlements: next } };
}

function replacePart(
	messages: FlueConversationMessage[],
	messageIndex: number,
	parts: FlueConversationPart[],
): FlueConversationMessage[] {
	const next = [...messages];
	next[messageIndex] = { ...(messages[messageIndex] as FlueConversationMessage), parts };
	return next;
}
