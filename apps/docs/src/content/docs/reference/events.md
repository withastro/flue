---
title: Events Reference
description: The observe() and instrument() registration contracts, the event envelope, every event type and its payload, and the live-only observation fields of the Flue runtime.
lastReviewedAt: 2026-07-30
---

This page documents the runtime events of `@flue/runtime`. It covers the `observe()` and `instrument()` registration contracts, the `FlueEvent` envelope, every event type and its payload, and the live-only fields a `FlueObservation` adds. For a consumer-oriented walkthrough of subscribing, metering usage, and exporting telemetry, see [Observability](/docs/guide/observability/). The per-conversation message stream a chat UI reads is a separate stream with a different schema. See the [Streaming Protocol Reference](/docs/reference/streaming-protocol/) and the [Flue Agent SDK events page](/docs/sdk/events/).

All symbols on this page are imported from `@flue/runtime` unless noted otherwise.

## `observe()`

```ts
function observe(subscriber: FlueEventSubscriber): () => void;

type FlueEventSubscriber = FlueObservationSubscriber;

type FlueObservationSubscriber = (
  observation: FlueObservation,
  ctx: FlueEventContext,
) => void | Promise<void>;
```

Registers a global subscriber for every runtime event emitted in the current process. The subscription covers all agents, harnesses, sessions, and task sessions that emit in this isolate. The returned function unsubscribes the listener.

- **Scope** — isolate-global and live-only. The subscription sees events emitted after registration. It has no durable replay or history access, and it does not aggregate across processes. On Node.js one process hosts all agents, so one registration sees everything. On [Cloudflare](/docs/guide/cloudflare-target/), each agent conversation runs in its own Durable Object isolate. A subscriber registered at module top level runs in each isolate and sees that isolate's activity only. [`flue run`](/docs/cli/run/) loads only the agent module, never `app.ts`, so a subscriber that must run under the CLI has to be registered in the agent module.
- **Delivery** — subscribers are invoked synchronously on the event emission path, after the runtime's own per-context consumers. Each emission constructs one `FlueObservation` (a deep clone of the event plus observation detail, with reference cycles preserved), deep-freezes it, and delivers that same frozen object to every subscriber.
- **Failure containment** — a subscriber that throws is caught and logged (`console.error` with the `[flue:observe]` prefix). Remaining subscribers still run, and the originating agent work is unaffected. A returned promise is observed for rejection (logged the same way) but never awaited.
- **Ordering** — events from one emitting context arrive in `eventIndex` order. Events from different contexts have no ordering guarantee.

The API does not provide type filtering, backpressure, replay, or any way to mutate or veto an event. Subscribers branch on `event.type` and must stay cheap because they run on the emission path.

#### `FlueEventContext`

```ts
interface FlueEventContext<TEnv = Record<string, any>> {
  readonly id: string;
  readonly agentName: string | undefined;
  readonly env: TEnv;
  readonly req: Request | undefined;
  readonly log: FlueLogger;
}

interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

The second subscriber argument is the runtime context of the agent interaction that emitted the event.

- `id` — the agent instance id. It equals the `instanceId` stamped on the context's events.
- `agentName` — the registered agent name, when known.
- `env` — platform bindings, which are `process.env` on Node and the Workers env object on Cloudflare.
- `req` — the invocation's Fetch `Request`, or `undefined` outside an HTTP context. Durable or recovered processing may carry a synthetic internal request instead of the original caller request.
- `log` — emits [`log` events](#log) into this context's event stream. Calling it from inside a subscriber emits further events, so guard against loops.

## `FlueEvent`

```ts
type FlueEvent = FlueEventInput & {
  v: 3;
  eventIndex: number;
  timestamp: string;
};
```

Every delivered event is one [event-type payload](#event-types) plus the envelope fields and the correlation fields that apply to the emitting activity:

```ts
// Correlation fields available on every event type (all optional):
{
  instanceId?: string;
  submissionId?: string;
  agentName?: string;
  conversationId?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
}
```

Envelope fields, present on every event:

- `v` — the durable event-format version, the literal `3`. Readers branch on this field when the format changes.
- `eventIndex` — a per-context counter, monotonically increasing within the emitting context. It provides ordering, not durable identity.
- `timestamp` — ISO 8601 string, stamped when the event is decorated for delivery.

Correlation fields, present when they apply:

- `instanceId` — the agent instance id. Present on direct and dispatched agent activity.
- `submissionId` — present while a durable submission is being processed, for dispatched and direct activity alike.
- `agentName` — the registered agent name, when known.
- `conversationId`, `session`: present on session-scoped events (turns, messages, tools, operations, compaction, session logs).
- `harness` — the emitting harness name. It is `"default"` for the root agent harness and the hook's name for lifecycle-hook harnesses.
- `parentSession`, `taskId`: present on events emitted inside a delegated task session.
- `operationId` — present on events emitted inside a running operation.
- `turnId` — present on events emitted during a model turn (in addition to the `turnId` payload field on the turn events themselves).

Ids are opaque generated strings. Correlate them by equality only.

`FlueEventInput` is the pre-decoration type (payload plus correlation fields, without `v`/`eventIndex`/`timestamp`). It is internal and not exported. Consumers always receive the decorated `FlueEvent`.

Two content guarantees hold for every event:

- **No raw image bytes.** Recognized image content blocks in event payloads carry the [`IMAGE_DATA_OMITTED`](#image_data_omitted) sentinel in place of their base64 data. Session history (model context) keeps the original bytes.
- **No throw-site stacks on durable-shaped error fields.** Errors serialized onto `operation`, `compaction`, `log`, `submission_recovery`, and `submission_settled` payloads never include stacks. The classified error object with an optional `stack` appears in two live-only places: `turn.response.error` and the observation's [`errorInfo`](#flueobservation).

## Event types

The v3 vocabulary contains 27 event types:

- Agent lifecycle: [`agent_start`, `agent_end`, `idle`](#agent_start-agent_end-idle)
- Submission lifecycle: [`submission_queued`, `submission_running`](#submission_queued-submission_running), [`submission_settled`](#submission_settled)
- Recovery: [`submission_recovery`](#submission_recovery)
- Operations: [`operation_start`, `operation`](#operation_start-operation)
- Model turns: [`turn_start`, `turn_request`, `turn`, `turn_messages`](#turn_start-turn_request-turn-turn_messages)
- Messages and deltas: [`message_start`, `message_end`, `text_delta`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_delta`](#message-and-delta-events)
- Tools: [`tool_start`, `tool`](#tool_start-tool)
- Tasks: [`task_start`, `task`](#task_start-task)
- Compaction: [`compaction_start`, `compaction`](#compaction_start-compaction)
- Logs: [`log`](#log)

Nested errors do not necessarily fail the work that contains them. An agent can recover from a failed turn or tool call. `submission_settled` is the reliable terminal signal, and `isError` on nested events is diagnostic context.

### `agent_start`, `agent_end`, `idle`

```ts
{ type: 'agent_start' }
{ type: 'agent_end'; messages: AgentMessage[] }
{ type: 'idle' }
```

- `agent_start` — an agent loop run began inside an operation.
- `agent_end` — the loop run ended. `messages` contains the messages that run produced (not the whole transcript). `AgentMessage` is the harness-level message type (roles `user`, `assistant`, `toolResult`, plus Flue's internal `signal` messages). It is not exported from `@flue/runtime` and is not a stable payload contract. See [Stability](#stable-contract-versus-internal-shapes).
- `idle` — the session finished an operation and returned to idle. Emitted after every terminal `operation` event, on success and failure alike. No payload fields.

### `submission_queued`, `submission_running`

```ts
{
  type: 'submission_queued';
  submissionId: string;
  kind: 'dispatch' | 'direct';
}
{
  type: 'submission_running';
  submissionId: string;
  kind: 'dispatch' | 'direct';
  attemptCount: number;
  maxAttempts: number;
}
```

These events start the `queued → running → settled` queue lifecycle, and [`submission_settled`](#submission_settled) completes it. `kind` records how the submission arrived. It is `dispatch` for `dispatch()` and `direct` for the agent HTTP route.

- `submission_queued` — a durable submission was admitted. Emitted immediately after durable admission, before any attempt, execution context, or render exists. Delivery is **at-least-once**. Admission cannot distinguish an idempotent replay, so replays (including `idempotencyKey`-deduplicated retries) re-emit it for the same `submissionId`.
- `submission_running` — an attempt began processing a claimed submission, before any model work. Emitted on every attempt. A recovery replacement re-emits it with the incremented `attemptCount`. The re-emission lets a fresh process or Durable Object isolate re-learn the busy set (see the derivation below) without any durable observer state.

A delivery that joins an already-busy conversation (dispatch-while-busy) emits `submission_queued` at admission and `submission_settled` when its host response settles. It never emits `submission_running`, because it never runs an attempt of its own.

`submission_queued` is emitted outside any execution context. Its envelope carries `agentName`/`instanceId` (and its own `eventIndex` sequence) but no `conversationId`/`session`. `submission_running` is emitted from the attempt's own context, so its correlation fields and `eventIndex` sequence are the ones the session events that follow continue.

#### Deriving instance busy/idle

This derivation is a stable, supported pattern. Mark an instance busy on `submission_queued` or `submission_running`, and clear that submission on `submission_settled`, keyed by `submissionId`.

```ts
import { observe } from '@flue/runtime';

// instanceId → the submissions currently keeping it busy.
const busy = new Map<string, Set<string>>();

observe((event) => {
  if (event.instanceId === undefined || event.submissionId === undefined) return;
  if (event.type === 'submission_queued' || event.type === 'submission_running') {
    let active = busy.get(event.instanceId);
    if (!active) busy.set(event.instanceId, (active = new Set()));
    active.add(event.submissionId);
  } else if (event.type === 'submission_settled') {
    const active = busy.get(event.instanceId);
    active?.delete(event.submissionId);
    if (active?.size === 0) busy.delete(event.instanceId); // instance went idle
  }
});
```

The pattern converges across process restarts and Durable Object eviction. A fresh isolate's recovery re-emits `submission_running` for every interrupted submission (and `submission_queued` re-fires on admission replays) before those submissions settle, so the new observer's busy set rebuilds itself. The at-least-once emissions are absorbed by the set semantics.

### `submission_recovery`

```ts
{
  type: 'submission_recovery';
  submissionId?: string; // absent for pass-wide failures
  kind?: 'dispatch' | 'direct';
  operation:
    | 'materialize_submission'
    | 'finalize_settlement'
    | 'reconcile_submission'
    | 'start_submission'
    | 'process_submission'
    | 'reconcile_pass'
    | 'enforce_deadline';
  outcome: 'deferred' | 'agent_unavailable' | 'attempt_cap_deferred' | 'terminated';
  attemptCount?: number;
  maxAttempts?: number;
  error?: {
    name?: string;
    message: string;
    type?: string;
    details?: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}
```

A coordinator recovery or reconciliation step failed (or skipped work) and was contained instead of terminalizing the submission. These failures never reach `submission_settled`. A submission stuck in a retry loop is visible here and nowhere else on the stream, so alert on this event alongside `submission_settled`.

- `operation` — the recovery step. One of `materialize_submission` (admission-side materialization of a queued row), `finalize_settlement` (finalizing a settlement reserved by a process that died), `reconcile_submission` (classifying an interrupted attempt), `start_submission` (starting a claimed attempt), `process_submission` (the processing and settlement logic around an attempt), `reconcile_pass` (a whole reconcile or claim pass with no single submission, so `submissionId` is absent), or `enforce_deadline` (a live attempt passed its durability deadline or an unhonored abort intent, so its abort signal was fired, and `deferred` marks the settle-grace window before the coordinator settles over a hung fiber).
- `outcome` — `deferred` (the work will be retried on the next scheduled wake), `agent_unavailable` (a queued row targets an agent that is no longer registered; retried until the agent is restored, the instance is aborted, or the unready auto-fail bound settles it failed), `attempt_cap_deferred` (retained for compatibility but no longer emitted, because bounded supervisor passes throttle reclaim cycles at wake cadence instead of an in-pass cap), or `terminated` (the failure was swallowed so a durable give-up could proceed, meaning "gave up durably" as opposed to "will retry"). A queued submission whose materialization keeps failing is not retried forever. Past its admission time plus the agent's `durability.timeoutMs` (default one hour), the coordinator settles it failed and emits `submission_settled` plus a `terminated` recovery event. A durable abort settles an unready row immediately.
- `error` — the same durable-shaped, stackless serialization as [`submission_settled.error`](#submission_settled). The live observation additionally carries the classified [`errorInfo`](#flueobservation) with the throw-site stack.

A persistent condition re-emits on every failed wake (roughly every 30 seconds once a coordinator falls back to its scheduled backstop). That repetition is the alerting signal. A missed emission is re-signaled on the next wake, so alert on recurrence and deduplicate by (`submissionId`, `operation`). Every emitting site also still writes its structured `console.error` line, so platform logs remain the zero-config trace.

#### Delivery contract

These guarantees hold for the submission-lifecycle and recovery events (and restate the general [`observe()`](#observe) contract where it matters most):

- **A throwing observer cannot break coordination** — Two mechanisms guarantee this. The dispatch path contains every global subscriber individually, and the coordinator's emitter cannot throw by construction. A failure signal can never worsen the failure it reports.
- **Ordering is per-emitting-context only**, as for every other event. Within one isolate's live view, a submission's events are causally ordered: `submission_queued` (where observed) precedes `submission_running`, which precedes `submission_settled`. Events have no cross-submission or cross-isolate ordering.
- **Delivery is live-only and best-effort.** It is at-most-once per emission occurrence, with no durable replay. Three properties make this workable. Recovery re-emits `submission_running` on every replacement attempt, so busy derivation converges. `submission_recovery` re-fires on every failed wake while a condition persists. The submission row and the canonical settlement record remain the durable source of truth. The stream is a signal, not a ledger. An application that needs guaranteed processing polls submission state or reads the conversation instead of relying on events.

### `submission_settled`

```ts
{
  type: 'submission_settled';
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: {
    name?: string;
    message: string;
    type?: string;
    details?: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}
```

A durable submission reached a terminal state. Emitted on every terminal path: normal completion, failure, abort, and recovery of an interrupted submission, including a settlement reserved by a process that died before finalizing it. Alert on this event for terminal failures, and pair it with [`submission_recovery`](#submission_recovery) for failures that never terminalize.

- `submissionId` — the settled submission. Also stamped as the envelope correlation field.
- `outcome` — `completed`, `failed`, or `aborted`.
- `error` — present unless `outcome` is `completed`. A [`FlueError`](/docs/reference/errors/) keeps its `name`, `message`, `type`, `details`, and `meta`; any other failure is replaced wholesale by a generic `internal_error` payload. Internal error messages never appear in this field. The live observation additionally carries the classified [`errorInfo`](#flueobservation), including the throw-site stack.

`submission_settled` is emitted at settlement, outside session scope. It carries the envelope and submission-level correlation fields but no `conversationId`/`session`. Settlement is also recorded durably as a settlement record appended to the canonical conversation stream (see the [Streaming Protocol Reference](/docs/reference/streaming-protocol/)). The runtime event itself is live-only like every other event.

### `operation_start`, `operation`

```ts
{
  type: 'operation_start';
  operationId: string;
  operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
}
{
  type: 'operation';
  operationId: string;
  operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
  durationMs: number;
  isError: boolean;
  error?: unknown;
  result?: unknown;
  usage?: PromptUsage;
}
```

These events bound one session operation, which is one `prompt()`, `skill()`, `task()`, `shell()`, or `compact()` call on a session or harness (see the [Agent API Reference](/docs/reference/agent-api/)). Every started operation emits exactly one terminal `operation` event.

- `operationId` — generated per operation. Every event emitted inside the operation carries it as a correlation field.
- `durationMs` — wall-clock duration of the operation.
- `isError` / `error`: `error` is present on failure, serialized without stacks. A `FlueError` becomes `{ name, message, type, details?, meta? }`, a plain `Error` becomes `{ name, message }`, and a non-`Error` thrown value passes through as-is.
- `result` — the operation's return value on success (for example a `PromptResponse`). Payloads can be large, so exporters should keep only the fields they need.
- `usage` — the operation result's aggregated `PromptUsage`, present when the result carries one (`prompt`, `skill`, `task`). `usage` here already includes the operation's `turn`-level usage, so sum one level only.

### `turn_start`, `turn_request`, `turn`, `turn_messages`

```ts
{ type: 'turn_start'; turnId: string; purpose: LlmTurnPurpose }
{
  type: 'turn_request';
  turnId: string;
  purpose: LlmTurnPurpose;
  request: ModelRequest;
}
{
  type: 'turn';
  turnId: string;
  purpose: LlmTurnPurpose;
  durationMs: number;
  request: ModelRequestInfo;
  response: ModelResponse;
  isError: boolean;
}
{
  type: 'turn_messages';
  turnId: string;
  purpose: LlmTurnPurpose;
  message: AgentMessage;
  toolResults: AgentMessage[];
}

type LlmTurnPurpose = 'agent' | 'compaction' | 'compaction_prefix';
```

One model call is one turn, correlated by `turnId`.

- `turn_start` — a model turn began. Emitted for agent-purpose turns only. Compaction turns emit `turn_request` and `turn` without a `turn_start`.
- `turn_request` — the full model-visible request, emitted before the provider call. It is **in-process only**, delivered to `observe()` subscribers but never persisted and never served over any transport. It is the only event that carries the system prompt, the complete message context, and the tool list.
- `turn` — the completed model call, with its request summary, normalized response, duration, and error status. `isError` is true when the call threw or the response finished with reason `error` or `aborted`.
- `turn_messages` — the turn boundary. It carries the assistant `message` and the `toolResults` its tool calls produced, emitted after any tool batch has durably committed. `toolResults` is empty for a turn without tool calls. Agent-purpose turns only.
- `purpose` — `agent` for conversation turns, `compaction` for a summarization call, or `compaction_prefix` for the extra prefix-summarization call a split-turn compaction dispatches.

The normalized `turn` events and the detailed `turn_messages`/`message_*` family describe the same model activity. Meter from one family or the other, not both.

#### `ModelRequest`, `ModelRequestInput`, `ModelRequestInfo`

```ts
interface ModelRequest extends ModelRequestInfo {
  input: ModelRequestInput;
}

interface ModelRequestInput {
  systemPrompt?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
}

interface ModelRequestInfo {
  providerId: string;
  providerName: string;
  requestedModel: string;
  api: string;
  serverAddress?: string;
  serverPort?: number;
  reasoningLevel?: string;
  maxTokens?: number;
  temperature?: number;
  contextCompacted?: true;
}
```

- `providerId` — the registration key from the model specifier.
- `providerName` — the semantic provider identity. It differs from `providerId` when a gateway or custom registration fronts the model.
- `requestedModel` — the model id Flue asked for.
- `api` — the wire API the provider speaks.
- `serverAddress`, `serverPort`: parsed from the provider endpoint when available.
- `reasoningLevel`, `maxTokens`, `temperature`: per-call settings, present when set.
- `contextCompacted` — `true` when an agent turn's effective context includes a canonical compaction summary. It remains true on later agent turns while that compacted view is in use. It is absent before compaction and on the internal `compaction` / `compaction_prefix` summarization turns. Never emitted as `false`.

`LlmMessage` (union of `LlmUserMessage`, `LlmAssistantMessage`, `LlmToolResultMessage`, built from `LlmTextContent`, `LlmThinkingContent`, `LlmImageContent`, `LlmToolCall`) and `LlmTool` are exported from `@flue/runtime`. Image blocks in `turn_request` messages carry [`IMAGE_DATA_OMITTED`](#image_data_omitted) instead of bytes. Internal `signal` messages are rendered into user-role text before they appear in `turn_request` input.

#### `ModelResponse`

```ts
interface ModelResponse {
  responseId?: string;
  responseModel?: string;
  output?: LlmAssistantMessage;
  usage?: PromptUsage;
  finishReason?: string;
  providerFinishReason?: string;
  gatewayLogId?: string;
  error?: FlueErrorInfo; // see FlueObservation.errorInfo for the field shape
}
```

- `responseId`, `responseModel`: provider-reported identity of the response, when reported.
- `output` — the assistant message the call produced, in the exported `Llm` shape.
- `usage` — provider-reported token and cost usage for this single call, absent when the provider reported none. Turn usage is the leaf level, and `operation` and `compaction` roll-ups already include it.
- `finishReason` — Flue's normalized finish vocabulary.
- `providerFinishReason` — the provider's exact finish value before normalization. Telemetry only; never part of replay or execution identity. Attached when the provider records it (the Workers AI provider does).
- `gatewayLogId` — the response's own Cloudflare AI Gateway log id (`cf-aig-log-id`), read from that response's headers. Telemetry only.
- `error` — the classified error for a failed call, in the same shape as the observation's [`errorInfo`](#flueobservation), including the throw-site `stack` when the failure was observed live from a thrown `Error`.

#### `PromptUsage`

```ts
interface PromptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

Token counts per component plus cost computed from the model catalog's per-million-token rates. The cost currency matches the rate's denomination, which is USD for the built-in registry's commercial providers.

### Message and delta events

```ts
{ type: 'message_start'; message: AgentMessage; turnId: string }
{ type: 'message_end'; message: AgentMessage; turnId: string }
{ type: 'text_delta'; text: string }
{ type: 'thinking_start'; contentIndex?: number }
{ type: 'thinking_delta'; contentIndex?: number; delta: string }
{ type: 'thinking_end'; contentIndex?: number; content: string }
{
  type: 'toolcall_delta';
  toolCallId: string;
  toolName: string;
  argumentTextDelta: string;
}
```

- `message_start` / `message_end`: bound every message the agent loop materializes, which includes the user prompt, each assistant message (started with the partial message, ended with the final one), and each tool-result message. For assistant messages, `message_end` carries the authoritative completed message. Deltas are best-effort live progress, and a subscriber registered mid-generation misses the deltas emitted before it attached.
- `text_delta` — a streamed fragment of assistant text.
- `thinking_start` / `thinking_delta` / `thinking_end`: bound one streamed reasoning block. `thinking_end.content` is the complete block. `contentIndex` is the zero-based index of the block within the assistant message's content array, when known. Correlate thinking events within a turn by `contentIndex`.
- `toolcall_delta` — a streamed fragment of one tool call's JSON-arguments text, for live previews of in-flight calls. Emitted only once the streaming block knows its `toolCallId` and `toolName`. These events are for live preview only and are never persisted or replayed. The canonical record and the `tool_start` observation remain the source of truth for complete arguments.

Delta events carry no `turnId` payload field. Correlate them through the envelope's `turnId` correlation field.

### `tool_start`, `tool`

```ts
{ type: 'tool_start'; toolName: string; toolCallId: string; args?: any }
{
  type: 'tool';
  toolName: string;
  toolCallId: string;
  isError: boolean;
  result?: unknown;
  durationMs: number;
}
```

Bounds of one tool execution, correlated by `toolCallId`. Emitted for model-invoked tool calls and for programmatic `shell()` calls alike (`shell()` appears as `toolName: 'bash'` with observation `origin: 'caller'`).

- `args` — declared in the format but not populated by the current runtime. The live observation's `args` field delivers the normalized arguments instead, and the canonical conversation record carries them durably.
- `isError` — true when the tool threw. Tools signal errors by throwing. A successful result value has no error flag.
- `result` — the tool's result value. For model tools this is the harness-level result shape (`content` blocks plus a tool-specific `details` payload). This is an internal type without a stability guarantee. Image blocks in `result.content` carry [`IMAGE_DATA_OMITTED`](#image_data_omitted).
- `durationMs` — measured once and shared with the durable record, so the two cannot disagree.

For model-invoked calls, the terminal `tool` event is published when the turn's tool batch durably commits, not when execution finishes. A tool whose batch is interrupted before commit never publishes its terminal event, which matches the durable outcome. `shell()` publishes immediately. `shell()` per-call `env` values are redacted to `<redacted>` in the recorded arguments (keys stay visible). A failed `shell()` carries an error-shaped result whose `details.exitCode` is `-1`.

### `task_start`, `task`

```ts
{
  type: 'task_start';
  taskId: string;
  prompt: string;
  agent?: string;
  cwd?: string;
}
{
  type: 'task';
  taskId: string;
  agent?: string;
  isError: boolean;
  result?: any;
  durationMs: number;
}
```

Bounds of one delegated task (a `session.task()` call or the model-facing `task` tool), correlated by `taskId`.

- `prompt` — the delegated instruction text.
- `agent` — the named subagent selected for the task, when one was.
- `cwd` — the task session's working directory override, when set.
- `result` — the task's assistant text on success, or the error message on failure.

Both events additionally carry `parentSession`, and the child's `session` and `conversationId`, as correlation fields. Events emitted inside the task session carry `taskId` and `parentSession` themselves.

### `compaction_start`, `compaction`

```ts
{
  type: 'compaction_start';
  reason: 'threshold' | 'overflow' | 'manual';
  estimatedTokens: number;
}
{
  type: 'compaction';
  messagesBefore: number;
  messagesAfter: number;
  durationMs: number;
  isError: boolean;
  error?: unknown;
  usage?: PromptUsage;
}
```

Bounds of one context compaction. Every `compaction_start` is followed by exactly one terminal `compaction` event.

- `reason` — `threshold` (automatic, the configured window threshold was crossed), `overflow` (automatic recovery from a context-overflow failure), or `manual` (an explicit `compact()` call).
- `estimatedTokens` — the estimated token size of the context being summarized.
- `messagesBefore` / `messagesAfter`: live message counts around the compaction.
- `error` — present on failure, in the same serialized shape as [`operation.error`](#operation_start-operation). A failed manual compaction also rejects the `compact()` call. Failed automatic compaction is best-effort and only observable here.
- `usage` — aggregated usage of the summarization call(s) the compaction dispatched. Those calls also emit their own `turn_request`/`turn` events with purpose `compaction` or `compaction_prefix`, and this roll-up includes them.

A compaction that finds nothing to compact emits no events.

### `log`

```ts
{
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
  attributes?: Record<string, unknown>;
}
```

A structured log line, emitted by `ctx.log` on [`FlueEventContext`](#flueeventcontext), the `log` on a tool's run context, the `log` on lifecycle-hook contexts, and the runtime's own diagnostics (prefixed `[flue:...]` in `message`).

- `attributes` — caller-supplied structured data. The runtime normalizes it in two ways. An `Error` instance under `attributes.error` is serialized to the stackless event-error shape, and the runtime stamps provenance keys (tool logs carry `tool` and `toolCallId`, hook logs carry `hook` and `hookIndex`).

Log events are runtime events only. The model never sees them, and they never appear in the conversation a client renders.

### Event order

For one durable submission whose `prompt` operation contains a single tool-calling turn, events arrive in this order:

1. `submission_queued` at admission
2. `submission_running` when the attempt starts processing
3. `operation_start`, `agent_start`
4. `message_start` / `message_end` for the user message
5. `turn_start`, `turn_request`
6. `message_start` for the assistant message; `text_delta`, `thinking_*`, and `toolcall_delta` interleave while it streams
7. `turn`, then `message_end` for the completed assistant message
8. per tool call: `tool_start` when execution begins, then `message_start` / `message_end` for its tool-result message when it finishes
9. the terminal `tool` events when the batch commits, then `turn_messages`
10. further turns repeat from step 5 until a turn produces no tool calls
11. `agent_end`, `operation`, `idle`
12. `submission_settled` when the submission settles

The sequence describes the uncontended path. A delivery that joins an already-busy conversation can interleave additional user `message_start` / `message_end` pairs at turn boundaries. Such a joined delivery contributes its own `submission_queued` and `submission_settled` but no `submission_running`.

## `FlueObservation`

```ts
type FlueObservation = FlueEvent & {
  agentInput?: { text: string; images?: Array<{ mimeType: string }> };
  agentOutput?:
    { type: 'text'; text: string; finishReason: string } | { type: 'data'; data: unknown };
  origin?: 'model' | 'caller' | 'framework' | 'adapter';
  description?: string;
  args?: unknown;
  effectiveResult?: unknown;
  toolCallId?: string;
  errorInfo?: {
    type: string;
    name?: string;
    code?: string;
    message?: string;
    meta?: Record<string, unknown>;
    stack?: string;
  };
};
```

`observe()` delivers this type, which adds exporter-oriented detail fields to the event. Every detail field is **live-only**. Detail fields are never persisted or replayed, and they never appear on any transported event. The detail fields are:

- `agentInput` — the invocation's prompt text and image manifest (MIME types only, no bytes). On the terminal `operation` event for `prompt` and `skill` operations, and on `task_start`.
- `agentOutput` — the invocation's outcome, either freeform text with its finish reason or the validated structured data of a `result:`-schema call. On successful `operation` (`prompt`/`skill`) and `task` events.
- `origin` — who initiated a tool call, one of `model` (model-invoked, including custom tools), `adapter` (sandbox-adapter tools), `framework` (framework-added tools such as `task` and result extraction), or `caller` (programmatic `shell()`). On `tool_start` and `tool`.
- `description` — the tool's description text. On `tool_start` and `tool` for model-invoked calls.
- `args` — the tool call's normalized arguments. On `tool_start`.
- `effectiveResult` — the tool's effective result as the model sees it (single text blocks collapsed to their string). On successful `tool` events. Image content is replaced with [`IMAGE_DATA_OMITTED`](#image_data_omitted).
- `toolCallId` — on `task_start` when the task was raised by a model `task` tool call, linking the task to that call.
- `errorInfo` — the classified error for a failed activity (`operation`, `tool`, `task`, `compaction`, `submission_recovery`, `submission_settled`; failed turns carry the same object as `turn.response.error` instead). `type` is the stable machine-readable category (a [`FlueError`](/docs/reference/errors/)'s `type`, else the error's `code`, `name`, or `_OTHER`). `meta` is framework-owned structured metadata (for example validation issues). `stack` is the throw-site stack, present only when the failure was observed live from a thrown `Error`. Stacks expose filesystem paths and deployment layout, which is why this projection exists only in process.

Observations are deep-frozen. Treat them as read-only.

`FlueObservationDetail` (the detail-fields object) and `FlueErrorInfo` are not exported as standalone types. Consume them through `FlueObservation`.

## `IMAGE_DATA_OMITTED`

```ts
const IMAGE_DATA_OMITTED = '[image data omitted from event]';
```

The sentinel that replaces raw base64 image bytes in every event payload. It appears in the message-bearing fields on `message_start`, `message_end`, `turn_messages`, and `agent_end`, in `tool` results, in `turn_request`/`turn` message content, and in the observation's `effectiveResult`. Events keep an image's presence and `mimeType` visible without carrying the payload. Session history and canonical attachments retain the original bytes for model context. Only events are redacted. The constant is exported from both `@flue/runtime` and `@flue/sdk`.

## `instrument()`

```ts
function instrument(instrumentation: FlueInstrumentation): () => Promise<void>;

interface FlueInstrumentation {
  key?: symbol;
  observe: FlueObservationSubscriber;
  interceptor: FlueExecutionInterceptor;
  dispose(): void | Promise<void>;
}
```

Installs an instrumentation bundle, which pairs an event subscriber (registered the same way as with `observe()`) with an [execution interceptor](#flueexecutioninterceptor) that wraps live agent, model, tool, and task execution. Tracing adapters such as [`@flue/opentelemetry`](/docs/ecosystem/tooling/opentelemetry/) use this registration. Returns a dispose function.

- `key` — optional identity symbol. While an instrumentation with a given key is installed, installing another with the same key throws `InstrumentationAlreadyInstalledError` (a `FlueError` with `type: 'instrumentation_already_installed'`) in production. In dev, the newest install wins and the prior one is disposed, which makes module-scope installations safe across dev-server reloads. Adapters use this to prevent double installation.
- `observe` — receives every event, with the same delivery, containment, and ordering contract as [`observe()`](#observe).
- `interceptor` — joins the process-wide interceptor chain for the duration of the installation.
- `dispose` — the bundle's own teardown (flush exporters, shut down providers). Called by the returned dispose function after the subscriber and interceptor are unregistered.

The returned dispose function is memoized and idempotent. Calling `instrument()` again with the same object returns the same function without reinstalling, and repeated calls to the function share one disposal. On the Node target, the server does not dispose a module-scope installation at shutdown, so an integration that must flush on exit should register its own signal handling. The installation survives dev-server reloads through key replacement, not disposal by the server. On Cloudflare, installations live and die with their isolate. A manually retained dispose function is only needed for dynamic wiring.

## `FlueExecutionInterceptor`

```ts
type FlueExecutionInterceptor = <T>(
  operation: FlueExecutionOperation,
  ctx: FlueExecutionContext,
  next: () => Promise<T>,
) => Promise<T>;

type FlueExecutionOperation =
  | { type: 'agent'; operationId: string; operationKind: 'prompt' | 'skill' | 'task' }
  | { type: 'model'; turnId: string }
  | { type: 'tool'; toolCallId: string; toolName: string }
  | { type: 'task'; taskId: string };

interface FlueExecutionContext {
  eventContext?: FlueEventContext;
  instanceId?: string;
  submissionId?: string;
  agentName?: string;
  conversationId?: string;
  harness?: string;
  session?: string;
  operationId?: string;
  turnId?: string;
  taskId?: string;
  traceCarrier?: { traceparent: string; tracestate?: string };
}
```

Middleware around live execution, registered through [`instrument()`](#instrument). Registered interceptors compose in registration order. Each receives a `next` continuation for the rest of the chain and the wrapped work itself.

- **Wrapped operations** — `agent` wraps a submission run and each `prompt`/`skill` session operation. At submission scope, `operationId` is the submission id with `operationKind: 'prompt'`. At session scope, it is the operation id. The current runtime does not raise the declared `operationKind: 'task'`, because it represents delegation with the `task` operation type. `model` wraps each provider call, correlated to the `turn` events by `turnId`. `tool` wraps each tool execution, and `task` wraps each delegated task. Scopes nest. A `model` interception runs inside its enclosing `agent` interception's async context, so a tracer can parent spans without any Flue-specific propagation.
- **`next` is exactly-once** — Calling it a second time rejects with an `Error` (`"Flue execution next() called more than once."`). Not calling it skips the wrapped work and the rest of the chain; the interceptor's return value becomes the operation's result.
- **`ctx` fields** — populated when known at the interception point. Submission scope carries `instanceId`, `submissionId`, `agentName`, and `traceCarrier`. Session scope carries `instanceId`, `harness`, `conversationId`, `session`, `operationId`, and, when active, `turnId` and `taskId`. `traceCarrier` is the validated W3C `traceparent`/`tracestate` pair extracted from the originating HTTP request, when one carried it. `eventContext` is declared in the type but not populated by the current runtime.

Interceptors run on the execution path. A slow interceptor slows the agent, and a throwing interceptor fails the wrapped operation.

## `AttachedAgentEvent`

```ts
type AttachedAgentEvent = FlueEvent & {
  instanceId: string;
};
```

A `FlueEvent` from a direct attached-agent interaction, with `instanceId` required instead of optional. It is a typing convenience for consumers of per-instance live streams. Attached-agent events are live activity, not durable history.

## Stable contract versus internal shapes

Stable, exported from `@flue/runtime`:

- The event envelope (`v`, `eventIndex`, `timestamp`) and correlation fields.
- The event type names and the payload fields shown on this page.
- `ModelRequest`, `ModelRequestInput`, `ModelRequestInfo`, `ModelResponse`, `PromptUsage`, `LlmTurnPurpose`, and the `Llm*` message and tool types. Exported symbols type every model-turn payload.
- `IMAGE_DATA_OMITTED`.

Internal types that appear in event payloads without a stability guarantee:

- `AgentMessage` values on `message_start`, `message_end`, `turn_messages`, and `agent_end`: the harness-level message representation, including internal roles. Consume completed model output through `turn.response.output` (typed by `LlmAssistantMessage`) instead where possible.
- `tool.result` and the observation's `effectiveResult`: tool result values whose `details` payload is tool-specific.
- `operation.result` — the operation's return value, whose shape follows the operation.

Format changes that break the stable contract bump `v`; additive optional fields do not.
