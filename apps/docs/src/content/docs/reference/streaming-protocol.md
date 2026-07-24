---
title: Streaming Protocol
description: The HTTP wire protocol for agent conversation reads and writes.
lastReviewedAt: 2026-07-21
---

This page documents the bytes on the wire: the HTTP surface that `createAgentRouter(agent)` serves for each agent conversation. Mounting, authentication, and CORS are application decisions covered in the [Routing guide](/docs/guide/routing/); the [Flue Agent SDK client](/docs/sdk/flue-client/) wraps this protocol so most applications never speak it by hand.

The protocol is identical on the Node.js and Cloudflare targets — both dispatch into the same handlers, so every request shape, response shape, header, and error below applies to both.

All routes are relative to wherever the router is mounted, plus the caller-chosen conversation id:

- `POST /:id` — deliver one message (202 admission).
- `GET /:id` — read the conversation: `view=history` (default) returns one materialized snapshot; `view=updates` returns incremental chunks, optionally live via long-poll or SSE.
- `HEAD /:id` — stream metadata as headers, no body.
- `POST /:id/abort` — abort in-flight and queued work.
- `GET /:id/attachments/:attachmentId` — attachment byte download.

`:id` must be a non-empty path segment; an empty or whitespace-only id is rejected with `invalid_request` (400). Any method not listed for a route is rejected with `method_not_allowed` (405) and an `Allow` header. Requests to a conversation that has never received a message return `stream_not_found` (404) on every read route — the conversation and its stream are created by the first admitted `POST`.

## Offsets

An offset is a resume token addressing a position in the conversation's durable record stream:

```
0000000000000000_0000000000000003
```

- The format is two 16-digit zero-padded integers joined by `_` (the Durable Streams offset format). The first component is always `0` in Flue.
- `-1` is the sentinel for "before the first batch": reading from `-1` replays the whole conversation.
- Offsets address durable record _batches_, not messages. One message delivery typically produces many batches, so offsets advance faster than messages appear. A batch whose records are all internal projects to zero chunks, so an updates response can be empty while `Stream-Next-Offset` advances.
- Treat offsets as opaque: obtain them from responses (the `offset` field of an admission or snapshot, the `Stream-Next-Offset` header, an SSE `control` event) and pass them back verbatim. Do not construct or interpret them.
- Reads are exclusive: a read at offset `X` returns data recorded _after_ `X`.
- An offset past the current stream head fails the read with `conversation_stream_store_failure` (500). A malformed offset (anything other than `-1` or the two-component form) is rejected with `invalid_request` (400).

## Coordination headers

Three response headers coordinate reads across requests:

- `Stream-Next-Offset` — the offset to resume from. Present on the 202 admission response, snapshot responses, non-SSE updates responses, and `HEAD`. In SSE mode the same value rides `control` events instead.
- `Stream-Up-To-Date` — literally `true` when the response reached the durable head at the time it was produced. Absent (never `false`) when more data was already available; keep reading from `Stream-Next-Offset`. Always `true` on snapshot and `HEAD` responses.
- `Location` — on the 202 admission response only: the conversation's stream URL (mirrors the body's `streamUrl`), following the Durable Streams stream-creation convention.

Browsers do not expose these headers cross-origin unless your CORS middleware lists them in `Access-Control-Expose-Headers`; see [CORS](/docs/guide/routing/#cors).

## `POST /:id` — message admission

Delivers one message into the conversation. The body is JSON (`Content-Type: application/json`) and is the same `DeliveredMessage` shape a server-side [`dispatch(...)`](/docs/guide/building-agents/#dispatch) admits, with two optional reserved top-level siblings. `@flue/sdk` exports `DeliveredMessage` and `DeliveredAttachment`.

```ts
type PromptBody = DeliveredMessage & {
  initialData?: unknown;
  uid?: string | null;
};

type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };

type DeliveredAttachment = {
  type: 'image';
  data: string; // base64
  mimeType: string;
  filename?: string;
};
```

- `kind: 'user'` — a direct user chat turn. `attachments` accepts images only; `data` is base64 and limited to 14,680,064 characters (14 × 1024 × 1024) — longer data is rejected with `invalid_request` (400).
- `kind: 'signal'` — a structured event delivery. `type` must be non-empty. `body` is a plain string; JSON-stringify structured payloads yourself. `tagName` must be a valid XML tag name (`^[A-Za-z_][A-Za-z0-9_.-]*$`); it is rendered unescaped as the signal's envelope in model context, so looser values are rejected with `invalid_request` (400).
- `initialData` — instance-creation data, consulted only when this send creates the conversation. When the agent declares an `initialData` schema, a creating send is validated against it; mismatches are rejected with `invalid_request` (400) before anything durable is admitted.
- `uid` — send condition. A string delivers only to the incarnation with that uid: an absent instance or a mismatched uid is rejected with `agent_instance_not_found` (404). `null` creates only when no instance exists: an existing instance is rejected with `agent_instance_exists` (409), whose `details` names the existing uid. Omitted sends deliver unconditionally. Combining a string `uid` with `initialData` is a contradiction (the condition forbids creation) and is rejected with `invalid_request` (400). Failed conditions leave nothing durable behind.

The bare-string shorthand that `dispatch(...)` accepts is not part of the wire: the body must be the object shape, or the request is rejected with `invalid_request` (400).

The route also accepts the W3C trace-context request headers `traceparent` and `tracestate`; a valid `traceparent` links the admitted submission to the caller's distributed trace.

### Admission response

Admission is fire-and-forget: the server responds `202 Accepted` once the message is durably admitted, before the agent runs.

```ts
{
  streamUrl: string; // the conversation's read URL (this URL, query stripped)
  offset: string; // durable head at admission
  submissionId: string; // identity of this delivery's settlement
  uid: string; // the contacted instance's uid
}
```

- `streamUrl` — derived from the request URL with the query string removed. Mirrored as the `Location` header.
- `offset` — the conversation's durable head at admission, after the message itself was recorded. An updates read from this offset observes everything the agent produces in response, without replaying history or the admitted message. Mirrored as the `Stream-Next-Offset` header.
- `submissionId` — matches the `submission-settled` chunk and the snapshot's `settlements` entries, so a client can await this specific delivery's outcome.
- `uid` — the contacted instance's uid: minted when this send created the instance, echoed when it continued one. Pass it back as the `uid` send condition to reach this same incarnation.

There is no synchronous "wait for the reply" mode: any `?wait` query parameter is rejected with `invalid_request` (400). Read the outcome from the conversation stream, or use the SDK's [`wait(...)`](/docs/sdk/flue-client/#wait).

A body that is not JSON is rejected with `unsupported_media_type` (415) when the `Content-Type` is wrong, or `invalid_json` (400) when the JSON is unparseable.

## `GET /:id?view=history` — snapshot

Returns one materialized snapshot of the conversation: every message reduced to complete, render-ready parts. `view=history` is the default; a plain `GET /:id` is the same request. Any `view` value other than `history` or `updates` is rejected with `invalid_request` (400), as is combining `view=history` with `offset`, `tail`, or `live`.

Response: `200`, `Content-Type: application/json`, `Cache-Control: no-store`, `Stream-Next-Offset` set to the snapshot's `offset`, `Stream-Up-To-Date: true`.

### `FlueConversationSnapshot`

`@flue/sdk` exports the snapshot shapes as `FlueConversationSnapshot`, `FlueConversationMessage`, `FlueConversationPart`, and `FlueConversationSettlement`.

```ts
interface FlueConversationSnapshot {
  v: 1;
  conversationId: string;
  offset: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
}

interface FlueConversationSettlement {
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: unknown;
}

interface FlueConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  purpose: 'user' | 'assistant' | 'dispatch' | 'advisory';
  display: 'visible' | 'hidden' | 'diagnostic';
  submissionId?: string;
  turnId?: string;
  signal?: { tagName?: string; attributes?: Record<string, string> };
  parts: FlueConversationPart[];
  metadata?: Record<string, unknown>;
}

type FlueConversationPart =
  | { type: 'text'; text: string; state: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
  | { type: `data-${string}`; data: unknown }
  | { type: 'file'; mediaType: string; id?: string; size?: number; url?: string; filename?: string }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'input-available';
      input: unknown;
    }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'output-available';
      input: unknown;
      output: unknown;
      durationMs?: number;
    }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'output-error';
      input: unknown;
      errorText: string;
      durationMs?: number;
    };
```

- `v` — snapshot schema version; currently `1`.
- `offset` — the durable head through which this snapshot was reduced, including batches that project to no visible message. Resuming an updates read from it yields exactly the changes after this snapshot.
- `messages` — the conversation transcript in order. One assistant message represents one whole response: every model step of a submission folds into the submission's first assistant message, with parts accumulating across steps.
- `settlements` — the terminal outcome of every settled submission on this conversation. `error` carries the caller-safe error value for `failed`/`aborted` outcomes.
- `role`/`purpose`/`display` — `role` is the coarse render lane; `purpose` classifies semantics (`dispatch` = delivered signals, `advisory` = runtime advisories); `display` is the visibility hint (`visible` primary chat, `diagnostic` activity-panel material, `hidden` plumbing).
- `signal` — present only on `system`-role messages projected from signal deliveries; carries the delivered `tagName` and `attributes`.
- `metadata` — entirely agent-authored (response-metadata hooks). The runtime stamps nothing; keys like `usage` or `model` are application conventions.
- `parts` — `text`/`reasoning` carry `state: 'streaming'` while a live response is mid-stream and `'done'` once complete. `data-<name>` parts are named client data writes, one part per write, in emit order. `file` parts reference attachments by `id`; `url` is never set by the server (the runtime does not know the public mount — the SDK resolves it client-side, and `GET /:id/attachments/:attachmentId` is the underlying route). `dynamic-tool` parts progress `input-available` → `output-available`/`output-error`; `durationMs` is the tool-handler execution time, absent on outcomes recorded before the field existed.

The snapshot covers exactly one conversation per agent instance: the default root conversation. Child conversations (subagent tasks and other internal sessions) are never exposed through this surface. The canonical durable record schema is likewise never exposed — snapshots and update chunks are the only read formats on the wire.

## `GET /:id?view=updates` — updates

Returns the conversation changes after an offset, as a JSON array of [update chunks](#conversationstreamchunk).

Query parameters:

- `offset` — required, exactly once: `-1` or a previously returned offset. Missing, repeated, or malformed values are rejected with `invalid_request` (400).
- `live` — optional: `long-poll` or `sse`. Any other value is rejected with `invalid_request` (400). Omitted = return immediately with whatever is available.
- `tail` — not supported on this surface; rejected with `invalid_request` (400). A stream suffix can omit message starts, compaction boundaries, and earlier deltas, so it cannot be projected safely.

Without `live`, the response is `200`, `Content-Type: application/json`, `Cache-Control: no-store`, with `Stream-Next-Offset` and (when the read reached the head) `Stream-Up-To-Date: true`. The body is a chunk array — empty when nothing was recorded after `offset`.

One response covers at most 100 durable batches (a fixed server page size; there is no wire parameter to change it). When `Stream-Up-To-Date` is absent, more data was already available: issue the next read from the returned `Stream-Next-Offset`.

Chunks are deltas against the conversation state at `offset`. Resume only from an offset whose state you hold — a snapshot's `offset`, or `-1` (a fresh read begins with a `conversation-reset` carrying a full snapshot). When local state is lost, request a fresh snapshot instead of guessing.

Serving an updates read reconstructs the conversation's reduced state through `offset` before projecting — there is no persisted replay cache — so the setup cost of each read or reconnect grows with the total length of the conversation's durable stream. Applications with very large conversations should measure reconnect latency and avoid unnecessary reconnect loops.

### `live=long-poll`

Identical to a plain updates read when data is available at `offset` — the response returns immediately. When nothing is available, the server holds the request until new data arrives or a 30-second window elapses, whichever is first:

- New data → `200` with the chunk array, as above.
- Timeout → `200` with an empty array `[]`, `Stream-Next-Offset` unchanged, `Stream-Up-To-Date: true`. Re-issue the request to continue waiting.
- Client disconnect while parked → the response is discarded with status `499` and no body.

### `live=sse`

Holds the connection open indefinitely and pushes chunks as server-sent events. Response: `200`, `Content-Type: text/event-stream`, `Cache-Control: no-cache`.

```
event: data
data:[{ "type": "message-delta", ... }, ...]

event: control
data:{"streamNextOffset":"0000000000000000_0000000000000007","upToDate":true}

: heartbeat
```

- `data` events — a JSON array of chunks, one event per read cycle. Emitted only when the cycle produced chunks.
- `control` events — stream coordination in the body, since headers cannot update mid-stream: `streamNextOffset` (string) and `upToDate` (present as `true` only when caught up). Emitted after every read cycle, including empty ones, so a caught-up stream still produces a `control` event at least every 30 seconds. Reconnect from the last `streamNextOffset` after a disconnect.
- `: heartbeat` comment lines — every 15 seconds, keeping intermediaries from timing out the idle connection.

The stream never ends server-side; it runs until the client disconnects. SSE is an at-least-once transport across reconnects — dedupe chunks by `position` (below).

### `ConversationStreamChunk`

Every chunk carries a `type`, the `conversationId`, and a `position`. `@flue/sdk` exports the union as `ConversationStreamChunk` (for first-party presenters; application code should consume the SDK's materialized `observe()` state instead).

```ts
type ConversationStreamChunk = ChunkBody & { position: { batch: number; index: number } };

type ChunkBody =
  | { type: 'conversation-reset'; conversationId: string; snapshot: FlueConversationSnapshot }
  | { type: 'message-appended'; conversationId: string; message: FlueConversationMessage }
  | {
      type: 'message-started';
      conversationId: string;
      messageId: string;
      submissionId?: string;
      turnId?: string;
      metadata?: Record<string, unknown>;
      timestamp?: string;
    }
  | {
      type: 'message-metadata';
      conversationId: string;
      messageId: string;
      metadata: Record<string, unknown>;
    }
  | { type: 'data-part'; conversationId: string; messageId: string; name: string; data: unknown }
  | {
      type: 'message-delta';
      conversationId: string;
      messageId: string;
      kind: 'text' | 'reasoning';
      delta: string;
    }
  | {
      type: 'tool-input';
      conversationId: string;
      messageId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      timestamp?: string;
    }
  | {
      type: 'tool-output';
      conversationId: string;
      toolCallId: string;
      output: unknown;
      durationMs?: number;
      timestamp?: string;
    }
  | {
      type: 'tool-output-error';
      conversationId: string;
      toolCallId: string;
      errorText: string;
      durationMs?: number;
      timestamp?: string;
    }
  | { type: 'message-completed'; conversationId: string; messageId: string; timestamp?: string }
  | {
      type: 'submission-settled';
      conversationId: string;
      submissionId: string;
      outcome: 'completed' | 'failed' | 'aborted';
      error?: unknown;
      timestamp?: string;
    };
```

- `position` — a monotonic ordering token: `batch` is the durable batch ordinal the chunk was projected from, `index` its position within that batch's projection. `{ batch, index }` is globally unique and ordered across the conversation; compare lexicographically (`batch`, then `index`) to dedupe redelivered chunks. Otherwise opaque — do not interpret the numbers.
- `conversation-reset` — replace all accumulated state with the embedded [snapshot](#flueconversationsnapshot). Emitted when a batch contains a structural boundary (conversation creation, compaction); the reset subsumes every other chunk of its batch, so a fresh read from `offset=-1` begins with one. The embedded snapshot may already contain settlements — check `snapshot.settlements` as well as `submission-settled` chunks when awaiting an outcome.
- `message-appended` — a complete message (user turn or system signal), in the same message format as the snapshot.
- `message-started` — an assistant response opened. `metadata` carries agent-authored response metadata available at start. Assistant chunks are pre-coalesced: every model step of a submission addresses the submission's first assistant `messageId`, so accumulating parts per `messageId` reproduces the snapshot's one-message-per-response shape. A later `message-started` for an already-open `messageId` is a continuation, not a new message.
- `message-metadata` — agent-authored metadata for an open response; merge onto the message.
- `data-part` — one named client data write; append a `data-<name>` part.
- `message-delta` — streamed `text` or `reasoning` content; append to the open part of that `kind`, opening one if none is open. A `kind` change or `message-completed` closes the open part.
- `tool-input` / `tool-output` / `tool-output-error` — tool-call lifecycle, correlated by `toolCallId`. Input arrives on the assistant message; outputs update the matching `dynamic-tool` part.
- `message-completed` — the assistant response closed; mark streaming parts `done`.
- `submission-settled` — the terminal outcome of one submission, matching the admission response's `submissionId`.
- `timestamp` — capture time (ISO 8601) of the underlying durable record, present on boundary chunks (`message-started`, `tool-input`, `tool-output`, `tool-output-error`, `message-completed`, `submission-settled`). `message-delta` deliberately omits it for wire weight; interpolate between stamped boundaries.

## `HEAD /:id`

Returns stream metadata as headers with no body: `Content-Type: application/json`, `Cache-Control: no-store`, `Stream-Next-Offset` (the current durable head), `Stream-Up-To-Date: true`. A missing stream returns `404` with error headers and no body.

## `POST /:id/abort`

Aborts all durable work for the conversation: the running submission and everything queued behind it. No request body is required. Response: `200`, JSON body:

```ts
{
  aborted: boolean;
}
```

- `aborted` — `true` when in-flight or queued work existed and is now being aborted; `false` when the conversation was idle. Abort records a durable intent and returns immediately — the affected submissions settle to the `aborted` outcome asynchronously. Observe the settlement via `submission-settled` chunks or the snapshot's `settlements`.

Methods other than `POST` are rejected with `method_not_allowed` (405), `Allow: POST`.

## `GET /:id/attachments/:attachmentId`

Serves one attachment's bytes. `:attachmentId` is the `id` of a `file` part; URI-encode it. Lookups are scoped to the conversation's default root conversation — attachments belonging to child conversations are never served and return `attachment_not_found` (404), as does an unknown id. A conversation that does not exist yet returns `stream_not_found` (404).

Response: `200` with the raw bytes and:

- `Content-Type` — the attachment's stored MIME type.
- `Content-Length` — the byte size.
- `Content-Disposition: inline`.
- `Cache-Control: private, max-age=31536000, immutable` — attachment content is digest-keyed and immutable, so clients may cache indefinitely.
- `Content-Security-Policy: sandbox` — the MIME type is uploader-controlled, so direct navigation is neutralized as an opaque origin; `<img>`/`<a>` sub-resource loads are unaffected.

Methods other than `GET` are rejected with `method_not_allowed` (405), `Allow: GET`.

## Error responses

Every error on this surface renders the canonical Flue envelope with `Content-Type: application/json`:

```ts
{
  error: {
    type: string;      // stable machine-readable category
    message: string;
    details: string;
    dev?: string;      // local development only
    meta?: Record<string, unknown>;
  };
}
```

Branch on `type`; message prose is not API. The type codes, statuses, and field semantics are documented in the [Errors Reference](/docs/reference/errors/#route-error-types). Statuses used by this surface: `invalid_request` and `invalid_json` (400), `agent_instance_not_found` and `stream_not_found` and `attachment_not_found` (404), `method_not_allowed` (405), `agent_instance_exists` (409), `unsupported_media_type` (415), `runtime_unavailable` (503, local dev reloads, with `Retry-After`), and `internal_error` or `conversation_stream_store_failure` (500). Unknown server failures never leak their original message — they render as a generic `internal_error`.

## Fixed response headers

Every read and error response carries two browser security headers: `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: cross-origin`.

The protocol sets no other cross-cutting headers by design:

- No `Access-Control-*` headers — CORS is application middleware; see [CORS](/docs/guide/routing/#cors), including which coordination headers to expose.
- No authentication challenges — protecting a mount is application middleware; see [Protecting your agents](/docs/guide/routing/#protecting-your-agents).
- No cache validators (`ETag`, `Last-Modified`) on conversation reads — offsets are the resume mechanism, and conversation responses are `no-store`.
