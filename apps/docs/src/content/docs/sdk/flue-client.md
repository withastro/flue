---
title: FlueClient
description: The Flue Agent SDK conversation client — send(), read(), wait(), abort(), history(), observe(), and attachmentUrl().
lastReviewedAt: 2026-07-21
---

## `FlueClient`

```ts
interface FlueClient {
  readonly url: string;
  send(options: AgentPromptOptions): Promise<AgentSendResult>;
  read(target: AgentSendResult | string, options?: AgentReadOptions): Promise<AgentReadResult>;
  wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
  abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
  history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
  observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
  attachmentUrl(attachmentId: string): string;
}
```

Client for one agent conversation, created by [`createFlueClient(...)`](/docs/sdk/create-flue-client/). Every HTTP method rejects with [`FlueApiError`](/docs/sdk/errors/#flueapierror) on a non-2xx response; the stream-backed methods (`wait()`, `observe()`) additionally surface [stream errors](/docs/sdk/errors/#stream-errors).

| Field | Description                                                                          |
| ----- | ------------------------------------------------------------------------------------ |
| `url` | The fully resolved conversation URL this client addresses, without a trailing slash. |

For chat UIs, `useFlueAgent({ url })` from `@flue/react` wraps this client with maintained React state; see [React](/docs/guide/react/).

## `send()`

```ts
send(options: AgentPromptOptions): Promise<AgentSendResult>;
```

`POST <conversation url>`. Starts one message delivery and resolves on admission (HTTP 202): the message is durably accepted, not processed. The result does not carry the agent's reply — pass it to [`read()`](#read) for the reply, [`wait()`](#wait) for just the outcome, or render progress with [`observe()`](#observe). The wire body is the `DeliveredMessage` verbatim, with `initialData` and `uid` as reserved top-level siblings.

### `AgentPromptOptions`

```ts
interface AgentPromptOptions {
  message: DeliveredMessage;
  initialData?: unknown;
  uid?: string | null;
  signal?: AbortSignal;
}
```

| Field         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`     | The message to deliver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `initialData` | Instance-creation data, consulted only when this send creates the conversation: validated against the agent's `initialData` schema static when the agent declares one, recorded once, and read inside the agent with `useInitialData()` (see [Passing data to the agent](/docs/guide/agent-hooks/#passing-data-to-the-agent)). Ignored when the send continues an existing conversation; pair with `uid: null` to error instead.                                                                                                                    |
| `uid`         | Send condition. Sends are conditional requests, with the instance uid playing the ETag. Omitted: unconditional — continues the instance or creates it. A string (a previous result's `uid`): continue only that incarnation. A missing instance or mismatched uid rejects with a 404 `FlueApiError` (`agent_instance_not_found`) and nothing is delivered. Cannot be combined with `initialData`. `null`: create only. An existing instance rejects with a 409 `FlueApiError` (`agent_instance_exists`, the existing uid in `body.error.meta.uid`). |
| `signal`      | Aborts the HTTP request. It does not abort agent work; that is [`abort()`](#abort).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `DeliveredMessage`

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };
```

The message delivered into the agent's session — the same unified shape the server accepts from `dispatch()`. `kind: 'user'` is a direct user chat turn addressing the agent 1:1. `kind: 'signal'` is a structured event — webhooks, schedules, and multi-user surfaces (a Slack thread, a GitHub issue) where the agent participates as one member and a `user` message would conflate other participants with the agent's own user.

Signal fields:

| Field        | Description                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `type`       | Caller-defined signal type (`'slack.message'`); must be non-empty.                                                         |
| `body`       | The signal content. A plain string; JSON-stringify structured payloads yourself.                                           |
| `attributes` | Structured string metadata (sender identity and the like), carried alongside the body into model context.                  |
| `tagName`    | Overrides the XML tag name the signal renders as in model context; the server rejects values that are not valid XML names. |

### `DeliveredAttachment`

```ts
interface DeliveredAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
}
```

One attachment on a `kind: 'user'` message. Images are the only supported attachment type.

| Field      | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `data`     | Base64-encoded image bytes. The server rejects data longer than 14 MiB of characters. |
| `mimeType` | The image MIME type (`image/png`, `image/jpeg`, …).                                   |
| `filename` | Optional original filename, surfaced on the projected `file` part.                    |

### `AgentSendResult`

```ts
interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string;
  uid: string;
}
```

All fields are server-provided.

| Field          | Description                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `streamUrl`    | Fully resolved Durable Streams URL for observing the conversation's events.                                                                                                                                               |
| `offset`       | Opaque stream offset captured at admission. Reading `streamUrl` from this offset yields exactly this prompt's events; `wait()` consumes it.                                                                               |
| `submissionId` | Correlates the admitted prompt with its messages and its settlement (the `submissionId` fields on [`FlueConversationMessage`](#flueconversationmessage) and [`FlueConversationSettlement`](#flueconversationsettlement)). |
| `uid`          | The contacted instance's uid: minted when this send created the conversation, echoed when it continued one. Pass it back as the `uid` option to guarantee later sends reach this same incarnation.                        |

## `read()`

```ts
read(target: AgentSendResult | string, options?: AgentReadOptions): Promise<AgentReadResult>;

type AgentReadOptions = AgentWaitOptions;

interface AgentReadResult {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
  submissionId: string;
  uid?: string;
}
```

Awaits one submission's settlement and resolves with its reply — the composed one-shot round trip:

```ts
const admission = await conversation.send({ message });
const reply = await conversation.read(admission);
```

The target is the admission `send()` resolved with, or a bare submission id. The bare form is the **re-attach** path: it follows the conversation from the stream origin, so any process holding just the id can read the reply at any later time, and a submission that already settled resolves immediately — persist the small admission object (or just its `submissionId`) and a crashed script's replacement picks up where the lost await stopped.

- Rejects with [`FlueExecutionError`](/docs/sdk/errors/#flueexecutionerror) when the submission settles failed or aborted, exactly as `wait()` does; the reply is fetched only after a completed settlement.
- The reply fields are [`readSubmissionReply()`](#readsubmissionreply)'s projection (text, named data parts, metadata) plus the settled `submissionId`; `uid` carries over when the target admission had one.
- `options` are [`AgentWaitOptions`](#agentwaitoptions) — `signal` stops the read locally (the submission keeps running; a durable stop is `abort()`), and `onEvent` streams chunks while waiting.
- Internally this is `wait()` plus one `history()` read. Use those primitives directly when you only need the outcome, or when you already hold the materialized conversation via `observe()` — `readSubmissionReply()` applies to its state with no extra fetch.

## `wait()`

```ts
wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
```

Awaits the admitted submission's completion by following the conversation's updates stream at `admission.streamUrl` from `admission.offset` (through the client's `fetch` and headers, so custom transports and auth apply). Settlement chunks for other submissions on the same conversation are ignored.

The wait is an observer, not a driver: if the waiting process disappears, the submission still settles server-side, and the settlement is durably recorded on the conversation. Recover the outcome by calling `wait()` again with the same admission, or by reading it from `history()`/`observe()`.

- Resolves `void` when the submission settles `completed`.
- Rejects with [`FlueExecutionError`](/docs/sdk/errors/#flueexecutionerror) (`failure: 'failed'` or `'aborted'`) when it settles failed or aborted; the error's `error` property carries the serialized failure detail when the server recorded one.
- Rejects with `FlueExecutionError` (`failure: 'terminal_event_missing'`) when the stream ends without this submission's settlement.
- Rejects with the signal's reason when `options.signal` aborts (a `DOMException` named `AbortError` when the abort carried no reason).

The agent's reply is not returned — settlement chunks carry only the outcome, which makes `wait()` the cheaper call when the outcome is all you need. For the reply, use [`read()`](#read), or extract it from a snapshot yourself with [`readSubmissionReply()`](#readsubmissionreply).

### `AgentWaitOptions`

```ts
interface AgentWaitOptions {
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
  onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}
```

| Field            | Description                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | Cancels the wait and its stream connection. The submission itself keeps running; stopping the work is [`abort()`](#abort).                                                                                                                                                                                                                   |
| `backoffOptions` | Retry behavior for stream connection attempts (`BackoffOptions` from `@durable-streams/client`, re-exported by the SDK).                                                                                                                                                                                                                     |
| `onEvent`        | Invoked for each conversation stream chunk while waiting and awaited before the next chunk is processed. Suited to progress output in scripts; prefer `observe()` for maintained UI state. `ConversationStreamChunk` is exported for first-party presenters but is not stable application API — see [Events and records](/docs/sdk/events/). |

## `abort()`

```ts
abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
```

`POST <conversation url>/abort`. Aborts all in-flight and queued durable work for the conversation — the currently running submission and any queued behind it. Resolves once the abort intent is recorded; the work settles to the distinct `aborted` outcome asynchronously. Observe that settlement via `wait()` (which rejects with `failure: 'aborted'`), `observe()`, or `history()`. Work that has already settled is not affected — an abort that loses the race to a finished response leaves it settled `completed`.

| Field    | Description              |
| -------- | ------------------------ |
| `signal` | Aborts the HTTP request. |

### `AgentAbortResult`

```ts
interface AgentAbortResult {
  aborted: boolean;
}
```

| Field     | Description                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `aborted` | `true` when there was in-flight or queued work that is now being aborted; `false` when the conversation was idle (nothing to abort). |

## `history()`

```ts
history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
```

`GET <conversation url>?view=history`. Reads one materialized conversation snapshot — a point-in-time read with no live updates (for those, use [`observe()`](#observe)). A missing conversation rejects with a 404 `FlueApiError`. Before returning, the SDK resolves a ready-to-use `url` onto every durably recorded `file` part (see [`attachmentUrl()`](#attachmenturl)).

```ts
interface FlueConversationHistoryOptions {
  signal?: AbortSignal;
}
```

### `FlueConversationSnapshot`

```ts
interface FlueConversationSnapshot {
  v: 1;
  conversationId: string;
  offset: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
}
```

A complete materialized conversation read at a durable-stream offset.

| Field         | Description                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`           | Snapshot format version.                                                                                                                                                |
| `offset`      | Opaque durable-stream checkpoint at which the snapshot was materialized. Pass it back only through Flue's own observation machinery; `observe()` manages it internally. |
| `messages`    | The conversation transcript, in order.                                                                                                                                  |
| `settlements` | Terminal outcomes of the conversation's tracked submissions.                                                                                                            |

### `FlueConversationMessage`

```ts
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
```

One message in a materialized conversation. An assistant message is one whole response: every model step of a tracked submission (text, tool calls, tool results, more text) accumulates as parts of a single message, in stream order — the same one-message-per-response shape as the AI SDK's `UIMessage`.

| Field          | Description                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Stable message identity; for an assistant response, the first step's message id.                                                                                                                                                                                       |
| `role`         | Coarse render lane, following the standard chat convention so a generic renderer can lay out a transcript. `system` covers every non-chat, non-answer message (internal control input and runtime advisories).                                                         |
| `purpose`      | Stable semantic classification, independent of rendered text: `user` is public chat, `assistant` is an answer, `dispatch` is internal dispatch/control input, `advisory` is a runtime advisory. The union may widen as the runtime grows typed agent-activity signals. |
| `display`      | How a transcript UI should treat the message: `visible` for primary chat, `diagnostic` for an activity/diagnostics panel, `hidden` for runtime plumbing that should not normally be shown.                                                                             |
| `submissionId` | Present on messages produced by a tracked submission.                                                                                                                                                                                                                  |
| `turnId`       | Per-turn grouping identity, shared by every message recorded within one model round-trip; absent on messages recorded outside a turn.                                                                                                                                  |
| `signal`       | Typed detail for a message projected from an internal runtime signal; present only on `system`-role messages.                                                                                                                                                          |
| `metadata`     | Entirely agent-authored: whatever the agent's `useResponseStart`/`useResponseFinish` hooks return, deep-merged in call order. The runtime stamps nothing — keys like `timestamp`, `usage`, or `model` are app conventions, present only when the agent attaches them.  |

### `FlueConversationPart`

```ts
type FlueConversationPart =
  | { type: 'text'; text: string; state: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
  | { type: `data-${string}`; data: unknown }
  | {
      type: 'file';
      mediaType: string;
      id?: string;
      size?: number;
      url?: string;
      filename?: string;
    }
  | ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
      | { state: 'input-available'; input: unknown }
      | { state: 'output-available'; input: unknown; output: unknown; durationMs?: number }
      | { state: 'output-error'; input: unknown; errorText: string; durationMs?: number }
    ));
```

One renderable part of a message. A part only ever carries materialized content plus a lifecycle `state`; streaming assembly details (delta sequencing, active blocks) are never exposed.

| Part                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text` / `reasoning` | Streamed model output. `state` is `'streaming'` while deltas are still arriving and `'done'` once the block closes.                                                                                                                                                                                                                                                                                                                       |
| `data-<name>`        | A named, client-facing data part streamed by the agent's `useDataWriter` writers (AI SDK convention: `data-<name>` type, payload on `data`). The name is the part's identity within the response — a later write updates the part in place, keeping its position. See [Streaming data to the client](/docs/guide/agent-hooks/#streaming-data-to-the-client).                                                                              |
| `file`               | One attachment. `id` is the stable attachment id, present once the attachment is durably recorded and absent on a local optimistic echo. `url` is ready to use as an `<img>`/`<a>` source: the SDK fills it for recorded attachments, and an optimistic echo carries a `data:` URL preview; it may be absent when the bytes are not yet resolvable. `size` is in bytes, when known. `filename` is present when the uploader provided one. |
| `dynamic-tool`       | One tool call, keyed by `toolCallId`. `input-available` means the call is recorded and its result pending; `output-available` carries the result on `output`; `output-error` carries the failure text on `errorText`. `durationMs` is the tool-handler execution time, present once the outcome is known (absent on outcomes recorded before the field shipped).                                                                          |

### `FlueConversationSettlement`

```ts
interface FlueConversationSettlement {
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: unknown;
}
```

Terminal outcome of one tracked agent submission within the conversation. `error` carries the serialized failure detail when the server recorded one.

## `readSubmissionReply()`

```ts
import { readSubmissionReply } from '@flue/sdk';

function readSubmissionReply(
  conversation: { messages: FlueConversationMessage[] },
  submissionId: string,
): AgentSubmissionReply;

interface AgentSubmissionReply {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
}
```

A pure function (no I/O, not a client method) that extracts one submission's reply from a materialized conversation — a `history()` snapshot or an `observe()` state. It is the projection behind [`read()`](#read); reach for it directly when you already hold the conversation and want no extra fetch:

```ts
const state = observation.getSnapshot().conversation;
const reply = readSubmissionReply(state, admission.submissionId);
```

The reply is the final assistant message stamped with the given `submissionId`. A submission that joined a busy response settles under the host's response, so when the submission produced no assistant message of its own, the conversation's last assistant message is the coalesced reply that answered it — prefer this helper over hand-picking `messages.at(-1)`, which silently reads the wrong message on a busy conversation.

- `text` — the reply's text parts joined with blank lines; `''` when none.
- `data` — named client data parts (`useDataWriter`) on the reply message, keyed by part name, each in emit order.
- `metadata` — agent-authored response metadata, when present.

The same projection backs the runtime's `init().read()`, so a reply read over HTTP and one read in-process agree.

## `observe()`

```ts
observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
```

Observes the materialized conversation across history catch-up and live updates. Returns synchronously with no network activity; the observation starts on its first `subscribe()` call.

On start, the observation reads one history snapshot, publishes it, then follows the conversation's updates stream from the snapshot's offset, reducing each chunk into the maintained [`FlueConversationState`](#flueconversationstate). Failure handling:

- A stream failure or unexpected end publishes phase `connecting` (with the error) and retries with exponential backoff — 1 s doubling per attempt, capped at 30 s — rehydrating a fresh snapshot rather than resuming incrementally. The attempt counter resets on every applied chunk and successful hydration.
- HTTP 400, 401, and 403 are fatal: phase `error`, no automatic retry. `refresh()` tries again.
- A 404 on the history read publishes phase `absent` (the conversation does not exist yet). The observation does not poll for it appearing; call `refresh()` to re-check.
- Aborting `options.signal` or calling `close()` publishes the terminal phase `closed`.

Chunk application is safe under at-least-once redelivery: every chunk carries a monotonic position, and chunks at or below the last applied position are dropped, so a replayed batch (an SSE reconnect) never double-applies.

`getSnapshot`/`subscribe` match React's `useSyncExternalStore` contract, and each published update is a new snapshot object identity. `useFlueAgent` from `@flue/react` builds on this method; see [React](/docs/guide/react/).

### `AgentConversationObserveOptions`

```ts
interface AgentConversationObserveOptions {
  live?: ConversationLiveMode;
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
}
```

| Field            | Description                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`           | Live update mode; defaults to `'long-poll'`.                                                                                                              |
| `signal`         | Closes the observation when aborted.                                                                                                                      |
| `backoffOptions` | Retry behavior for individual stream connection attempts (`BackoffOptions` from `@durable-streams/client`), beneath the observation's own rehydrate loop. |

### `ConversationLiveMode`

```ts
type ConversationLiveMode = 'long-poll' | 'sse';
```

| Mode        | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| `long-poll` | Offset-resumed polling.                                        |
| `sse`       | A long-lived stream, for lower-latency token-by-token updates. |

Both modes are safe under redelivery. For a single point-in-time read with no live updates, use [`history()`](#history).

### `AgentConversationObservation`

```ts
interface AgentConversationObservation {
  getSnapshot(): AgentConversationObservationSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  close(reason?: unknown): void;
}
```

| Method                | Description                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSnapshot()`       | The current snapshot; a new object per published update.                                                                                                                                                               |
| `subscribe(listener)` | Registers a change listener; the first call starts the observation. Returns an unsubscribe function. Unsubscribing removes the listener but does not stop the underlying stream — only `close()` or the `signal` does. |
| `refresh()`           | Drops the current connection and rehydrates from a fresh history snapshot. Use it to re-check an `absent` conversation or retry after a fatal `error`. No-op once closed.                                              |
| `close(reason)`       | Terminally stops the observation and publishes phase `closed`; a provided reason is normalized to an `Error` and published on the snapshot's `error`.                                                                  |

### `AgentConversationObservationSnapshot`

```ts
interface AgentConversationObservationSnapshot {
  conversation: FlueConversationState | undefined;
  offset: string | undefined;
  phase: AgentConversationObservationPhase;
  error: Error | undefined;
}
```

| Field          | Description                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation` | The materialized state; `undefined` before the first hydration completes and when the conversation is `absent`.                                  |
| `offset`       | Opaque durable-stream checkpoint the state corresponds to.                                                                                       |
| `phase`        | Connection lifecycle; see below.                                                                                                                 |
| `error`        | The most recent connection failure while `connecting`, the fatal failure when `error`, or the normalized `close(reason)`; `undefined` otherwise. |

### `AgentConversationObservationPhase`

```ts
type AgentConversationObservationPhase =
  'loading' | 'connecting' | 'live' | 'absent' | 'error' | 'closed';
```

| Phase        | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `loading`    | The first hydration is in flight; no state yet.                                                   |
| `connecting` | State may be present; the live connection is being established or re-established after a failure. |
| `live`       | Following live updates.                                                                           |
| `absent`     | The history read returned 404: the conversation does not exist.                                   |
| `error`      | Fatal HTTP status (400, 401, 403); no automatic retry.                                            |
| `closed`     | Terminal: the `signal` aborted or `close()` was called.                                           |

### `FlueConversationState`

```ts
interface FlueConversationState {
  conversationId: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
}
```

The live materialized conversation maintained by `observe()` — [`FlueConversationSnapshot`](#flueconversationsnapshot) without the `v`/`offset` envelope (the offset lives on the observation snapshot).

## `attachmentUrl()`

```ts
attachmentUrl(attachmentId: string): string;
```

Returns the absolute URL for one `file` part's attachment bytes — `<conversation url>/attachments/<attachmentId>`, with the id URL-encoded — suitable as an `<img>`/`<a>` source. The route is part of every mounted agent router, accepts `GET` only, and returns 404 for an unknown attachment id.

No request is made and no auth is attached: the returned string is only a URL, so the request made with it must itself satisfy whatever middleware guards the mount. You rarely need this method directly — `history()` and `observe()` resolve `url` onto every durably recorded `file` part already. Over a Cloudflare service binding the URL's host is the placeholder origin; forward it through the same fetcher (see [the service-binding guide](/docs/guide/cloudflare-target/#calling-a-private-agent-over-a-service-binding)).
