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
	/**
	 * A named, client-facing data part streamed by the agent's
	 * `useDataWriter` writers (AI SDK convention: `data-<name>` type, payload
	 * on `data`). The name is the part's identity within the response — a
	 * later write updates the part in place.
	 */
	| { type: `data-${string}`; data: unknown }
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
			| {
					state: 'input-available';
					input: unknown;
					output?: never;
					errorText?: never;
					durationMs?: never;
			  }
			// `durationMs` is the tool-handler execution time; present once the
			// outcome is known (absent on outcomes recorded before the field).
			| {
					state: 'output-available';
					input: unknown;
					output: unknown;
					errorText?: never;
					durationMs?: number;
			  }
			| {
					state: 'output-error';
					input: unknown;
					output?: never;
					errorText: string;
					durationMs?: number;
			  }
	  ));

/**
 * Coarse render lane for a materialized message. `system` covers every
 * non-chat, non-answer message (internal control input and runtime advisories),
 * following the standard chat convention so a generic renderer can lay out a
 * transcript without understanding the finer {@link FlueConversationMessagePurpose}.
 */
type FlueConversationMessageRole = 'user' | 'assistant' | 'system';

/**
 * Stable semantic classification of a message, independent of its rendered
 * text. Lets clients distinguish public chat (`user`), assistant answers
 * (`assistant`), internal dispatch/control input (`dispatch`), and runtime
 * advisories (`advisory`) without parsing content, ordering, or timestamps.
 * The union may widen as the runtime grows typed agent-activity signals.
 */
type FlueConversationMessagePurpose = 'user' | 'assistant' | 'dispatch' | 'advisory';

/**
 * How a transcript UI should treat a message: `visible` for primary chat,
 * `diagnostic` for content suited to an activity/diagnostics panel, `hidden`
 * for runtime plumbing that should not normally be shown.
 */
type FlueConversationMessageDisplay = 'visible' | 'hidden' | 'diagnostic';

/**
 * Typed detail for a message projected from an internal runtime signal. Present
 * only on `system`-role messages. Carries across history snapshots and live
 * updates so clients can subtype or correlate signals without parsing text.
 */
interface FlueConversationSignalDescriptor {
	tagName?: string;
	attributes?: Record<string, string>;
}

/**
 * One message in a materialized conversation. An assistant message is one
 * whole response: every model step of a tracked submission (text, tool calls,
 * tool results, more text) accumulates as parts of a single message, in
 * stream order — the same one-message-per-response shape as the AI SDK's
 * `UIMessage`.
 */
export interface FlueConversationMessage {
	/** Stable message identity; for an assistant response, the first step's message id. */
	id: string;
	role: FlueConversationMessageRole;
	/** Stable semantic classification; see {@link FlueConversationMessagePurpose}. */
	purpose: FlueConversationMessagePurpose;
	/** Render/visibility hint; see {@link FlueConversationMessageDisplay}. */
	display: FlueConversationMessageDisplay;
	/** Present on messages produced by a tracked submission. */
	submissionId?: string;
	/**
	 * Stable per-turn grouping identity. Shared by every message recorded within
	 * one model round-trip; absent on messages recorded outside a turn.
	 */
	turnId?: string;
	/** Typed signal detail; present only on `system`-role messages. */
	signal?: FlueConversationSignalDescriptor;
	parts: FlueConversationPart[];
	/**
	 * Message metadata is entirely agent-authored: whatever the agent's
	 * `useResponseStart`/`useResponseFinish` hooks return, deep-merged in call order. The
	 * runtime stamps nothing — keys like `timestamp`, `usage`, or `model` are
	 * app conventions, present only when the agent attaches them.
	 */
	metadata?: Record<string, unknown>;
}

/** Terminal outcome of one tracked agent submission within a conversation. */
export interface FlueConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
	/**
	 * The submission whose response answered this one — for a delivery that
	 * joined a live response, the host submission whose coalesced reply
	 * settled it. Server-derived; absent on settlements recorded before the
	 * linkage shipped and on submissions that produced no assistant message.
	 */
	answeredBySubmissionId?: string;
}

/**
 * A complete materialized conversation read at a durable-stream offset.
 *
 * Returned by the client's `history()` and used to seed `observe()`. The
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

/** Options for one `history()` read. */
export interface FlueConversationHistoryOptions {
	signal?: AbortSignal;
}
