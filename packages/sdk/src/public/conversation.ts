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
	/**
	 * Structured settlement marker; present only on the terminal advisory the
	 * runtime appends when a submission settles short of a reply, so clients
	 * can render a failed or aborted turn structurally instead of parsing the
	 * advisory's prose. The message's `submissionId` names the settled
	 * submission. Completed submissions get no marker — the assistant reply is
	 * the marker — and `settlements` remains the programmatic outcome index.
	 */
	settlement?: { outcome: 'failed' | 'aborted' };
	/**
	 * Server-authored capture time (ISO 8601) of the durable record behind
	 * this message, present for every role and for existing conversations.
	 * For a `user` or `system` message it is when the input or signal was
	 * applied to the conversation (not when the submission was accepted); for
	 * an assistant response it is when the response's first step started.
	 * Absent on the optimistic echo `useFlueAgent` renders before the server
	 * confirms a send. Timestamps are server wall-clock times — not guaranteed
	 * unique or monotonic — so order messages by array position, never by
	 * timestamp.
	 */
	timestamp?: string;
	parts: FlueConversationPart[];
	/**
	 * Message metadata is entirely agent-authored: whatever the agent's
	 * `useResponseStart`/`useResponseFinish` hooks return, deep-merged in call order. The
	 * runtime stamps nothing into it — keys like `usage` or `model` are app
	 * conventions, present only when the agent attaches them. The server's
	 * capture time lives on {@link FlueConversationMessage.timestamp}.
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
	/** Server-authored capture time (ISO 8601) of the submission's settlement. */
	timestamp?: string;
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
	/**
	 * Opaque identity of the stream generation the snapshot was read from. A
	 * runtime whose conversation store was reset and regrown (a dev-server
	 * restart on the in-memory store) starts a new generation that serves
	 * different content at overlapping offsets; `observe()` compares this
	 * against the `stream-checkpoint` chunks on the live stream and re-hydrates
	 * on mismatch. Absent on snapshots embedded in `conversation-reset` chunks,
	 * where the generation cannot have changed within the delivering connection.
	 */
	incarnation?: string;
	messages: FlueConversationMessage[];
	/**
	 * Terminal outcomes of the conversation's tracked submissions. Always the
	 * whole conversation's settlements, even on a bounded read.
	 */
	settlements: FlueConversationSettlement[];
	/**
	 * Present only on bounded reads (`history({ limit })`): the opaque cursor
	 * for the next older page — pass it to `historyBefore()` — or `null` when
	 * `messages` already starts at the beginning of the conversation. Absent
	 * on unbounded reads, and on any read served by a runtime that predates
	 * bounded history (which returns the whole conversation). A cursor is
	 * bound to the stream generation it was read from: once the stream is
	 * reset, reads with it reject with a 410 `history_cursor_not_found`.
	 */
	before?: string | null;
}

/**
 * One page of older messages read with `historyBefore()`. Not a checkpoint:
 * it carries no stream offset and cannot seed `observe()`. Settlements are
 * not repeated here — the bounded snapshot or observation that produced the
 * cursor already carries the whole conversation's settlements.
 */
export interface FlueConversationHistoryPage {
	v: 1;
	conversationId: string;
	/** Messages strictly older than the cursor, oldest first. */
	messages: FlueConversationMessage[];
	/** Cursor for the next older page, or `null` at the start of the conversation. */
	before: string | null;
}

/** Live materialized conversation maintained by `observe()`. */
export interface FlueConversationState {
	conversationId: string;
	messages: FlueConversationMessage[];
	/** The whole conversation's settlements, including under a bounded `observe({ limit })`. */
	settlements: FlueConversationSettlement[];
	/**
	 * Present only on a bounded observation (`observe({ limit })`): the opaque
	 * cursor for the messages older than the observed window — pass it to
	 * `historyBefore()` — or `null` when the window reaches the start of the
	 * conversation. Absent on unbounded observations.
	 */
	before?: string | null;
}

/** Options for one `history()` read. */
export interface FlueConversationHistoryOptions {
	/**
	 * Read only the newest `limit` messages (a positive integer). The snapshot
	 * still carries the head `offset`, the `incarnation`, and every
	 * settlement, plus a `before` cursor for `historyBefore()`. `limit` counts
	 * every message, hidden and diagnostic ones included, and the window may
	 * hold more when a response that is still streaming sits above the newest
	 * messages. Omit to read the whole conversation.
	 */
	limit?: number;
	signal?: AbortSignal;
}

/** Options for one `historyBefore()` read. */
export interface FlueConversationHistoryBeforeOptions {
	/**
	 * Page size (a positive integer): read at most this many messages, the
	 * newest ones older than the cursor. Required, so a page read is always
	 * bounded.
	 */
	limit: number;
	signal?: AbortSignal;
}
