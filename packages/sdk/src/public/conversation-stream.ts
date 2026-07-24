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
 * the first delta or on a `kind` change. An assistant message is one whole
 * response: the runtime addresses every step of a multi-step submission at the
 * same message id, so a later step's `message-started` finds the message
 * already present (a no-op) and its parts accumulate there. Each chunk carries a monotonic
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
	| {
			type: 'conversation-reset';
			conversationId: string;
			snapshot: FlueConversationSnapshot;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'message-appended';
			conversationId: string;
			message: FlueConversationMessage;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			/** Turn this assistant message belongs to; stamped onto the synthesized
			 *  message so live grouping matches the snapshot projection. */
			turnId?: string;
			/** Agent-authored response metadata from `useResponseStart` hooks. */
			metadata?: Record<string, unknown>;
			/** Capture time (ISO 8601) of the underlying canonical record. */
			timestamp?: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'message-metadata';
			conversationId: string;
			messageId: string;
			metadata: Record<string, unknown>;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'data-part';
			conversationId: string;
			messageId: string;
			name: string;
			data: unknown;
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
			timestamp?: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'tool-output';
			conversationId: string;
			toolCallId: string;
			output: unknown;
			durationMs?: number;
			timestamp?: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'tool-output-error';
			conversationId: string;
			toolCallId: string;
			errorText: string;
			durationMs?: number;
			timestamp?: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'message-completed';
			conversationId: string;
			messageId: string;
			timestamp?: string;
			position: ConversationChunkPosition;
	  }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: unknown;
			/** See {@link FlueConversationSettlement.answeredBySubmissionId}. */
			answeredBySubmissionId?: string;
			timestamp?: string;
			position: ConversationChunkPosition;
	  };

/**
 * Thrown by the reducer when an incremental chunk cannot be applied to the
 * current state (an unknown chunk shape). `observe()` recovers by rehydrating a
 * fresh snapshot.
 */
export class ConversationStreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConversationStreamError';
	}
}

const CHUNK_TYPES = new Set<ConversationStreamChunk['type']>([
	'conversation-reset',
	'message-appended',
	'message-started',
	'message-delta',
	'message-metadata',
	'data-part',
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
export function assertConversationStreamChunk(
	value: ConversationStreamChunk,
): ConversationStreamChunk {
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
				// A started chunk whose message already exists is a continuation
				// step of the same response — a no-op here; its parts accumulate on
				// the open message.
				if (messages.some((message) => message.id === chunk.messageId)) return messages;
				return [
					...messages,
					{
						id: chunk.messageId,
						role: 'assistant',
						purpose: 'assistant',
						display: 'visible',
						...(chunk.submissionId ? { submissionId: chunk.submissionId } : {}),
						...(chunk.turnId ? { turnId: chunk.turnId } : {}),
						parts: [],
						...(chunk.metadata ? { metadata: chunk.metadata } : {}),
					},
				];
			});
		case 'message-metadata':
			return mutateMessages(state, (messages) => {
				const index = messages.findIndex((message) => message.id === chunk.messageId);
				if (index < 0) return messages;
				const message = messages[index] as FlueConversationMessage;
				const next = [...messages];
				next[index] = {
					...message,
					metadata: deepMergeMetadata(message.metadata ?? {}, chunk.metadata),
				};
				return next;
			});
		case 'data-part':
			return mutateMessages(state, (messages) => {
				const index = messages.findIndex((message) => message.id === chunk.messageId);
				if (index < 0) return messages;
				const message = messages[index] as FlueConversationMessage;
				const partType = `data-${chunk.name}` as const;
				const partIndex = message.parts.findIndex((part) => part.type === partType);
				// The name is the part's identity within the response: the first
				// write appends at the live end; a rewrite updates the part in
				// place, keeping its position.
				const parts =
					partIndex < 0
						? [...message.parts, { type: partType, data: chunk.data }]
						: message.parts.map((part, i) =>
								i === partIndex ? { type: partType, data: chunk.data } : part,
							);
				const next = [...messages];
				next[index] = { ...message, parts };
				return next;
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
				...(chunk.durationMs !== undefined ? { durationMs: chunk.durationMs } : {}),
			}));
		case 'tool-output-error':
			return applyToolResult(state, chunk.toolCallId, (part) => ({
				...part,
				state: 'output-error',
				output: undefined,
				errorText: chunk.errorText,
				...(chunk.durationMs !== undefined ? { durationMs: chunk.durationMs } : {}),
			}));
		case 'message-completed':
			return completeMessage(state, chunk.messageId);
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
			if (
				last &&
				(last.type === 'text' || last.type === 'reasoning') &&
				last.state === 'streaming'
			) {
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
		if (
			message.parts.some(
				(part) => part.type === 'dynamic-tool' && part.toolCallId === chunk.toolCallId,
			)
		) {
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
	update: (part: Extract<FlueConversationPart, { type: 'dynamic-tool' }>) => FlueConversationPart,
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

function completeMessage(state: FlueConversationState, messageId: string): FlueConversationState {
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
		};
		return next;
	});
}

/** Deep-merge metadata: later values win, plain objects merge recursively, proto keys dropped. */
function deepMergeMetadata(
	base: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue;
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
		const current = merged[key];
		merged[key] =
			isPlainObject(current) && isPlainObject(value) ? deepMergeMetadata(current, value) : value;
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function applySettlement(
	state: FlueConversationState,
	chunk: Extract<ConversationStreamChunk, { type: 'submission-settled' }>,
): FlueConversationState {
	const settlement: FlueConversationSettlement = {
		submissionId: chunk.submissionId,
		outcome: chunk.outcome,
		...(chunk.error === undefined ? {} : { error: chunk.error }),
		...(chunk.answeredBySubmissionId === undefined
			? {}
			: { answeredBySubmissionId: chunk.answeredBySubmissionId }),
	};
	const settlements = state.settlements;
	const index = settlements.findIndex((value) => value.submissionId === settlement.submissionId);
	const next =
		index < 0
			? [...settlements, settlement]
			: settlements.map((value, i) => (i === index ? settlement : value));
	return { ...state, settlements: next };
}
