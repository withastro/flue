---
title: Events Reference
description: Reference runtime activity, attached-agent event types, and global observation APIs.
lastReviewedAt: 2026-06-12
---

Observable runtime types and global observation APIs are exported from `@flue/runtime`.

```ts
import {
  type AttachedAgentEvent,
  type FlueEvent,
  observe,
  type FlueEventSubscriber,
} from '@flue/runtime';
```

## Runtime events

`FlueEvent` is the observable runtime activity union. Workflow invocations emit workflow-run events with `runId`. Direct prompts and asynchronously dispatched agent inputs emit agent activity with `instanceId`; dispatched activity may also carry `dispatchId`. Those interactions are not workflow runs.

Every delivered event carries the durable event-format version `v: 1`, a per-context `eventIndex`, and a `timestamp`. Applicable events may also carry harness and session names, generated operation and turn ids, task correlation, and parent-session correlation. Events are durably stored in an event stream and can be replayed from any offset via the Durable Streams protocol — except `turn_request`, which is delivered to in-process subscribers only (see below).

Runtime events can contain payloads, prompts, system instructions, reasoning-bearing messages, logs, tool arguments, tool results, and terminal errors. Apply an exporter-local sanitization policy before forwarding events to an external service.

Events never carry raw image bytes. Image content blocks in event payloads keep their `mimeType` but have `data` replaced with the sentinel string `'[image data omitted from event]'`, exported as the `IMAGE_DATA_OMITTED` constant from both `@flue/runtime` and `@flue/sdk`. Session history retains the real bytes for model context.

### Lifecycle events

| Event         | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `run_start`   | Workflow run started. Includes the workflow name and payload.                                                   |
| `run_resume`  | Recovery continued handling an admitted workflow run after interruption. Workflow code did not resume or retry. It can be the first persisted lifecycle event when interruption occurs after admission but before `run_start`. |
| `run_end`     | Workflow run ended. Includes result or error state and duration.                                                |
| `agent_start` | Agent loop started.                                                                                             |
| `agent_end`   | Agent loop ended.                                                                                               |
| `idle`        | Agent activity became idle.                                                                                     |

### Agent operations

| Event             | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `operation_start` | A `prompt`, `skill`, `task`, `shell`, or `compact` operation started.             |
| `operation`       | An operation ended. Includes duration, error state, and optional result or usage. |
| `task_start`      | Delegated task started.                                                           |
| `task`            | Delegated task ended.                                                             |

Operations, turns, task ids, and tool-call ids are generated correlation boundaries. Harnesses and sessions have names. Harness-level shell activity emits tool telemetry without a session operation boundary.

### Model turns

| Event                                              | Meaning                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `turn_start`                                       | Model turn started.                                                                                     |
| `turn_request`                                     | Model-visible request. Includes provider, model, input, tools, and optional reasoning level. **In-process only**: delivered to `observe()` subscribers and exporters, never persisted to durable streams or served over HTTP. |
| `turn`                                             | Model turn ended. Normalized terminal telemetry: duration, error state, and optional output or usage.   |
| `turn_messages`                                    | Detailed turn payload. Includes the raw assistant message and tool-result messages.                     |
| `message_start`, `message_update`, `message_end`   | Detailed assistant-message stream.                                                                      |
| `text_delta`                                       | Text stream delta.                                                                                      |
| `thinking_start`, `thinking_delta`, `thinking_end` | Thinking stream lifecycle.                                                                              |

`turn_request` and `turn` use purpose `agent`, `compaction`, or `compaction_prefix`. Count model activity from either the normalized `turn` events or the detailed `turn_messages`/`message_*` family, not both.

### Tool calls

| Event        | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `tool_start` | Tool execution started. Includes tool name and arguments.              |
| `tool`       | Tool execution ended. Includes duration, error state, and result.      |

Both model-driven and programmatic (`shell()`) tool activity emit `tool_start` and `tool`. Use `toolCallId` to correlate related events.

### Compaction

| Event              | Meaning                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `compaction_start` | Conversation compaction started. Includes `threshold`, `overflow`, or `manual` reason.             |
| `compaction`       | Conversation compaction ended. Includes message counts, duration, error state, and optional usage. |

### Logs

| Event | Meaning                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- |
| `log` | Structured application log with `info`, `warn`, or `error` level and optional attributes. |

### Stable contract vs. provider-shaped fields

Event type names, the envelope fields (`v`, `eventIndex`, `timestamp`, identity and correlation fields), and the normalized payloads — `turn_request`/`turn` (the `Llm*` mirror types), `tool_start`/`tool`, `task`, `operation`, `compaction`, `run_*`, `log`, `text_delta`, and `thinking_*` — are the stable event contract.

The detailed message payloads are **not yet stable**: `message` on `message_start`/`message_update`/`message_end`, `message` and `toolResults` on `turn_messages`, and `messages` on `agent_end` mirror the message shape of the underlying agent library (pi-agent-core's `AgentMessage`) and may change shape before 1.0, when they will be replaced with a Flue-owned message type. Readers of persisted streams can branch on the envelope's `v` field when the format changes.

#### `FlueEvent`

```ts
type FlueEvent = RuntimeEventVariant & {
  v: 1;
  eventIndex: number;
  timestamp: string;
  runId?: string;
  instanceId?: string;
  dispatchId?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
};
```

## Attached agent events

Attached-agent events represent direct-agent activity. They omit workflow lifecycle events, require `instanceId`, and never carry `runId`.

#### `AttachedAgentEvent`

```ts
type AttachedAgentEvent = Exclude<
  FlueEvent,
  { type: 'run_start' } | { type: 'run_resume' } | { type: 'run_end' }
> & {
  runId?: never;
  instanceId: string;
};
```

## Global observation

### `observe(...)`

```ts
function observe(subscriber: FlueEventSubscriber): () => void;
```

Subscribes to live workflow-run and agent-interaction activity emitted in the current isolate. The returned function unsubscribes the listener. Subscribers run synchronously from the event emission path with isolated JSON snapshots. Keep callbacks lightweight and queue substantial asynchronous work instead of blocking emission. Returned promises are observed for rejection but are not awaited.

`observe()` receives every emitted event, including `turn_request` — the full model-visible request is available to in-process observability without being persisted to the primary database.

See [Observability](/docs/guide/observability/) for application setup and exporter guidance.

#### `FlueEventSubscriber`

```ts
type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void | Promise<void>;
```

Receives an isolated decorated event snapshot and its originating context. Subscriber failures are logged and do not halt event dispatch or the originating execution. If an event cannot be serialized as JSON, Flue logs the snapshot failure and skips global observer delivery for that event.

## Public errors

Transport errors use the shared `FluePublicError` shape. See [Errors Reference](/docs/api/errors-reference/) for its fields, stable categories, transport envelopes, and the distinction between transport errors and open-ended workflow failure records.
