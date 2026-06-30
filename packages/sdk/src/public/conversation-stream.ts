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
 *
 * Streaming assistant content is carried by `message-delta`: a delta appends to
 * the message's current streaming part of the same `kind`, opening a new part on
 * the first delta or on a `kind` change. Each chunk carries a monotonic
 * `position`; `observe()` applies chunks in order and drops any at or below the
 * last applied position, so a redelivered batch (e.g. an SSE reconnect) never
 * double-applies.
 */
/**
 * Monotonic ordering token stamped on every chunk by the runtime projection.
 * `observe()` compares it (lexicographically by `batch` then `index`) to dedupe
 * chunks redelivered under at-least-once transports (e.g. an SSE reconnect).
 * Opaque otherwise — do not interpret the numbers.
 */
export type ConversationChunkPosition = { batch: number; index: number };

export type ConversationStreamChunk =
	| { type: 'conversation-reset'; conversationId: string; snapshot: FlueConversationSnapshot; position: ConversationChunkPosition }
	| { type: 'message-appended'; conversationId: string; message: FlueConversationMessage; position: ConversationChunkPosition }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			/** Server-authored generation-start time as an ISO 8601 string. */
			timestamp?: string;
			model?: { provider: string; id: string };
			position: ConversationChunkPosition;
	  }
	| {
			type: 'message-delta';
			conversationId: string;
			messageId: string;
			kind: 'text' | 'reasoning';
			delta: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'tool-input';
			conversationId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
			position: ConversationChunkPosition;
	  }
	| { type: 'tool-output'; conversationId: string; toolCallId: string; output: unknown; position: ConversationChunkPosition }
	| { type: 'tool-output-error'; conversationId: string; toolCallId: string; errorText: string; position: ConversationChunkPosition }
	| { type: 'message-completed'; conversationId: string; messageId: string; usage?: PromptUsage; position: ConversationChunkPosition }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			result?: unknown;
			error?: unknown;
			position: ConversationChunkPosition;
	  };

/**
 * Thrown by the reducer when an incremental chunk cannot be applied to the
 * current state (an unknown chunk shape). `observe()` recovers by rehydrating a
 * fresh snapshot.
 */
export class ConversationStreamError extends Error {
	readonly recover: 'rehydrate';
	constructor(message: string) {
		super(message);
		this.name = 'ConversationStreamError';
		this.recover = 'rehydrate';
	}
}

const CHUNK_TYPES = new Set<ConversationStreamChunk['type']>([
	'conversation-reset',
	'message-appended',
	'message-started',
	'message-delta',
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
	// `position` is the dedup identity `observe()` relies on; reject chunks that
	// lack a valid one so a protocol/version mismatch fails loudly (triggering
	// rehydrate) instead of silently disabling deduplication.
	const position = (value as { position?: { batch?: unknown; index?: unknown } }).position;
	if (!position || !Number.isFinite(position.batch) || !Number.isFinite(position.index)) {
		throw new ConversationStreamError(
			`Agent conversation chunk is missing a valid position: ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

export function createConversationStreamState(
	snapshot: FlueConversationSnapshot,
): FlueConversationState {
	return {
		conversationId: snapshot.conversationId,
		messages: snapshot.messages,
		settlements: snapshot.settlements,
	};
}

export function applyConversationChunk(
	state: FlueConversationState,
	chunk: ConversationStreamChunk,
): FlueConversationState {
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
						...(chunk.timestamp || chunk.model
							? {
									metadata: {
										...(chunk.timestamp ? { timestamp: chunk.timestamp } : {}),
										...(chunk.model ? { model: chunk.model } : {}),
									},
								}
							: {}),
					},
				];
			});
		case 'message-delta':
			return appendDelta(state, chunk);
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
	state: FlueConversationState,
	update: (messages: FlueConversationMessage[]) => FlueConversationMessage[],
): FlueConversationState {
	const messages = update(state.messages);
	if (messages === state.messages) return state;
	return { ...state, messages };
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

/**
 * Appends streaming content to a message. The delta extends the message's last
 * part when it is a streaming part of the same `kind`; otherwise it opens a new
 * streaming part and closes the previous streaming text/reasoning part (a `kind`
 * change is a block boundary). Two adjacent blocks of the same `kind` with no
 * intervening boundary (no tool call, no kind change, no completion) merge into
 * one part — block identity within a single kind is not represented on the wire.
 */
function appendDelta(
	state: FlueConversationState,
	chunk: Extract<ConversationStreamChunk, { type: 'message-delta' }>,
): FlueConversationState {
	return mutateMessages(state, (messages) => {
		const index = messages.findIndex((message) => message.id === chunk.messageId);
		if (index < 0) return messages;
		const message = messages[index] as FlueConversationMessage;
		const last = message.parts[message.parts.length - 1];
		const parts = [...message.parts];
		if (last && last.type === chunk.kind && last.state === 'streaming') {
			parts[parts.length - 1] = { ...last, text: last.text + chunk.delta };
		} else {
			if (last && (last.type === 'text' || last.type === 'reasoning') && last.state === 'streaming') {
				parts[parts.length - 1] = { ...last, state: 'done' };
			}
			parts.push({ type: chunk.kind, text: chunk.delta, state: 'streaming' });
		}
		const next = [...messages];
		next[index] = { ...message, parts };
		return next;
	});
}

function appendToolInput(
	state: FlueConversationState,
	chunk: Extract<ConversationStreamChunk, { type: 'tool-input' }>,
): FlueConversationState {
	return mutateMessages(state, (messages) => {
		const index = messages.findIndex((message) => message.id === chunk.messageId);
		if (index < 0) return messages;
		const message = messages[index] as FlueConversationMessage;
		if (message.parts.some((part) => part.type === 'dynamic-tool' && part.toolCallId === chunk.toolCallId)) {
			return messages;
		}
		// A tool call is a block boundary: any preceding streaming text/reasoning
		// part is complete, so mark it done rather than leaving it streaming until
		// the whole message completes.
		const parts = message.parts.map((part, partIndex) =>
			partIndex === message.parts.length - 1 &&
			(part.type === 'text' || part.type === 'reasoning') &&
			part.state === 'streaming'
				? { ...part, state: 'done' as const }
				: part,
		);
		const next = [...messages];
		next[index] = {
			...message,
			parts: [
				...parts,
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
	state: FlueConversationState,
	toolCallId: string,
	update: (
		part: Extract<FlueConversationPart, { type: 'dynamic-tool' }>,
	) => FlueConversationPart,
): FlueConversationState {
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
	state: FlueConversationState,
	messageId: string,
	usage: PromptUsage | undefined,
): FlueConversationState {
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
	state: FlueConversationState,
	chunk: Extract<ConversationStreamChunk, { type: 'submission-settled' }>,
): FlueConversationState {
	const settlement: FlueConversationSettlement = {
		submissionId: chunk.submissionId,
		outcome: chunk.outcome,
		...(chunk.result === undefined ? {} : { result: chunk.result }),
		...(chunk.error === undefined ? {} : { error: chunk.error }),
	};
	const settlements = state.settlements;
	const index = settlements.findIndex((value) => value.submissionId === settlement.submissionId);
	const next = index < 0 ? [...settlements, settlement] : settlements.map((value, i) => (i === index ? settlement : value));
	return { ...state, settlements: next };
}
