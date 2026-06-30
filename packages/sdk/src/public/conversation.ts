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
			 * persisted yet.
			 */
			id?: string;
			/** Attachment size in bytes, when known. */
			size?: number;
			/**
			 * URL for the attachment bytes, ready to use as an `<img>`/`<a>` source.
			 * The SDK fills this in for durably-recorded attachments (a hosted URL on
			 * the agent's opt-in attachments route); a local optimistic echo carries a
			 * `data:` URL preview of the bytes being uploaded. May be absent when the
			 * bytes are not yet resolvable.
			 */
			url?: string;
			/** Original filename, when the uploader provided one. */
			filename?: string;
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
		/**
		 * Server-authored message creation time as an ISO 8601 string. For a user
		 * message this is when it was recorded; for an assistant message it is when
		 * generation started. A local optimistic echo carries a client-authored time
		 * until its canonical copy (with the server time) arrives.
		 */
		timestamp?: string;
		usage?: PromptUsage;
		model?: { provider: string; id: string };
	};
}

/** Terminal outcome of one tracked agent submission within a conversation. */
export interface FlueConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
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
