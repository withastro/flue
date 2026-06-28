import type { PromptUsage } from '../types.ts';

/**
 * One renderable part of a conversation message.
 *
 * Flue projects its private canonical conversation log into this small, stable
 * shape. Streaming assembly details (delta sequencing, active blocks) are never
 * exposed here; a part only ever carries materialized content plus a lifecycle
 * `state`.
 */
export type FlueConversationPart =
	| { type: 'text'; text: string; state: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
	| {
			type: 'file';
			mediaType: string;
			/**
			 * Stable attachment id. Present on attachments that have been durably
			 * recorded; absent on a local optimistic echo whose bytes have not been
			 * persisted yet. Fetch the bytes with
			 * `client.agents.attachmentUrl(name, id, attachment.id)`.
			 */
			id?: string;
			/** Attachment size in bytes, when known. */
			size?: number;
	  }
	| ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
			| { state: 'input-available'; input: unknown; output?: never; errorText?: never }
			| { state: 'output-available'; input: unknown; output: unknown; errorText?: never }
			| { state: 'output-error'; input: unknown; output?: never; errorText: string }
	  ));

/** One message in a materialized conversation. */
export interface FlueConversationMessage {
	id: string;
	role: 'user' | 'assistant';
	/** Present on messages produced by a tracked submission. */
	submissionId?: string;
	parts: FlueConversationPart[];
	metadata?: {
		usage?: PromptUsage;
		model?: { provider: string; id: string };
	};
}

/** Terminal outcome of one tracked agent submission within a conversation. */
export interface FlueConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed';
	result?: unknown;
	error?: unknown;
}

/**
 * A complete materialized conversation read at a durable-stream offset.
 *
 * Returned by `client.agents.history()` and used to seed `observe()`. The
 * `offset` is an opaque durable-stream checkpoint; pass it back only through
 * Flue's own observation machinery.
 */
export interface FlueConversationSnapshot {
	v: 1;
	conversationId: string;
	offset: string;
	messages: FlueConversationMessage[];
	settlements: FlueConversationSettlement[];
}

/** Live materialized conversation maintained by `observe()`. */
export interface FlueConversationState {
	conversationId: string;
	messages: FlueConversationMessage[];
	settlements: FlueConversationSettlement[];
}

/** Options for one `client.agents.history()` read. */
export interface FlueConversationHistoryOptions {
	signal?: AbortSignal;
}
