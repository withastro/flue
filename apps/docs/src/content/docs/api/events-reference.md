---
title: Events Reference
description: Reference runtime activity, attached-agent streams, WebSocket messages, and global observation APIs.
lastReviewedAt: 2026-05-30
---

Observable runtime types are exported from `@flue/runtime`. Global observation APIs are exported from `@flue/runtime/app`.

```ts
import {
  type AgentWebSocketClientMessage,
  type AgentWebSocketServerMessage,
  type AttachedAgentEvent,
  type AttachedAgentStreamError,
  type FlueEvent,
  type FluePublicError,
  type WebSocketErrorMessage,
  type WebSocketServerMessage,
  type WorkflowWebSocketClientMessage,
  type WorkflowWebSocketServerMessage,
} from '@flue/runtime';
import { observe, type FlueEventSubscriber } from '@flue/runtime/app';
```

## Runtime events

`FlueEvent` is the observable runtime activity union. Workflow invocations emit workflow-run events with `runId`. Direct prompts and asynchronously dispatched agent inputs emit agent activity with `instanceId`; dispatched activity may also carry `dispatchId`. Those interactions are not workflow runs.

Runtime-emitted events receive a per-context `eventIndex` and `timestamp`. Applicable events may also carry harness and session names, generated operation and turn ids, task correlation, and parent-session correlation. Workflow history persists events where run-store persistence succeeds. Attached-agent streams and `observe(...)` are live observation surfaces, not durable workflow history.

### Lifecycle events

| Event         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `run_start`   | Workflow run started. Includes workflow ownership, payload, and optional restart linkage. |
| `run_resume`  | Recovery resumed an admitted workflow run.                                                |
| `run_end`     | Workflow run ended. Includes result or error state and duration.                          |
| `agent_start` | Agent loop started.                                                                       |
| `agent_end`   | Agent loop ended.                                                                         |
| `idle`        | Agent activity became idle.                                                               |

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
| `turn_request`                                     | Model-visible request. Includes provider, model, input, tools, and optional reasoning level.            |
| `turn_end`                                         | Detailed model turn ended. Includes assistant message and tool results.                                 |
| `turn`                                             | Normalized terminal model-turn telemetry. Includes duration, error state, and optional output or usage. |
| `message_start`, `message_update`, `message_end`   | Detailed assistant-message stream.                                                                      |
| `text_delta`                                       | Text stream delta.                                                                                      |
| `thinking_start`, `thinking_delta`, `thinking_end` | Thinking stream lifecycle.                                                                              |

`turn_request` and `turn` use purpose `agent`, `compaction`, or `compaction_prefix`. Select detailed or normalized events intentionally when an observer must avoid double-counting model activity.

### Tool calls

| Event                   | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `tool_execution_start`  | Detailed tool execution started.                                       |
| `tool_execution_update` | Detailed partial tool result.                                          |
| `tool_execution_end`    | Detailed tool execution ended.                                         |
| `tool_start`            | Normalized tool telemetry started.                                     |
| `tool_call`             | Normalized terminal tool telemetry. Includes duration and error state. |

Detailed and normalized events overlap for model-driven tool execution. Programmatic shell activity emits normalized tool telemetry but not necessarily detailed execution events. Use `toolCallId` to correlate related events.

### Compaction

| Event              | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `compaction_start` | Conversation compaction started. Includes `threshold`, `overflow`, or `manual` reason. |
| `compaction`       | Conversation compaction ended. Includes message counts, duration, and optional usage.  |

### Logs

| Event | Meaning                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- |
| `log` | Structured application log with `info`, `warn`, or `error` level and optional attributes. |

#### `FlueEvent`

```ts
type FlueEvent = RuntimeEventVariant & {
  runId?: string;
  instanceId?: string;
  dispatchId?: string;
  eventIndex?: number;
  timestamp?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
};
```

## Attached agent events

Attached-agent streams expose live direct-agent activity. They omit workflow lifecycle events, require `instanceId`, and never carry `runId`. They are distinct from persisted workflow-run event streams.

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

#### `AttachedAgentStreamError`

```ts
interface AttachedAgentStreamError {
  type: 'error';
  instanceId: string;
  error: FluePublicError;
}
```

Terminal error frame emitted after an attached-agent SSE stream has started.

`FlueEventCallback` and `AttachedAgentEventCallback` remain package-visible low-level callback aliases, but their supported public role is deferred pending an API decision.

## Global observation

### `observe(...)`

```ts
function observe(subscriber: FlueEventSubscriber): () => void;
```

Subscribes to live workflow-run and agent-interaction activity emitted in the current isolate. The returned function unsubscribes the listener. Subscribers run synchronously from the event emission path; keep them lightweight, do not mutate events, and queue asynchronous work with application-owned rejection handling instead of blocking.

See [Observability](/docs/guide/observability/) for application setup and exporter guidance.

#### `FlueEventSubscriber`

```ts
type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void;
```

Receives the decorated event and its originating context. Synchronous subscriber failures are logged and do not halt event dispatch or the originating execution.

## Public errors

Transport errors use the shared `FluePublicError` shape. See [Errors Reference](/docs/api/errors-reference/) for its fields, stable categories, transport envelopes, and the distinction between transport errors and open-ended workflow failure records.

## WebSocket protocol messages

These exports describe low-level protocol version 1 messages. For high-level external client APIs, see [SDK API](/docs/sdk/overview/).

#### `AgentWebSocketClientMessage`

```ts
type AgentWebSocketClientMessage =
  | { version: 1; type: 'prompt'; requestId: string; message: string; session?: string }
  | { version: 1; type: 'ping'; requestId?: string };
```

#### `AgentWebSocketServerMessage`

```ts
type AgentWebSocketServerMessage =
  | { version: 1; type: 'ready'; target: 'agent'; name: string; instanceId: string }
  | { version: 1; type: 'started'; requestId: string }
  | { version: 1; type: 'event'; requestId: string; event: AttachedAgentEvent }
  | { version: 1; type: 'result'; requestId: string; result: unknown }
  | WebSocketErrorMessage
  | { version: 1; type: 'pong'; requestId?: string };
```

Agent sockets can process sequential prompts. `requestId` correlates prompt-scoped messages.

#### `WorkflowWebSocketClientMessage`

```ts
interface WorkflowWebSocketClientMessage {
  version: 1;
  type: 'invoke';
  requestId: string;
  payload?: unknown;
}
```

#### `WorkflowWebSocketServerMessage`

```ts
type WorkflowWebSocketServerMessage =
  | { version: 1; type: 'ready'; target: 'workflow'; name: string }
  | { version: 1; type: 'started'; requestId: string; runId: string }
  | { version: 1; type: 'event'; requestId: string; runId: string; event: FlueEvent }
  | { version: 1; type: 'result'; requestId: string; runId: string; result: unknown }
  | WebSocketErrorMessage
  | { version: 1; type: 'error'; requestId?: string; runId: string; error: FluePublicError };
```

Workflow sockets accept one invocation and close after completion or failure. `started` reports an admitted workflow invocation before workflow events are delivered.

#### `WebSocketErrorMessage`

```ts
type WebSocketErrorMessage = {
  version: 1;
  type: 'error';
  requestId?: string;
  error: FluePublicError;
};
```

Connection- or request-scoped WebSocket failure. Workflow failures may include `runId` through the run-scoped `WorkflowWebSocketServerMessage` error variant.

#### `WebSocketServerMessage`

```ts
type WebSocketServerMessage = AgentWebSocketServerMessage | WorkflowWebSocketServerMessage;
```
