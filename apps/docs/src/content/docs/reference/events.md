---
title: Events Reference
description: The runtime event vocabulary — the observe() and instrument() registration contracts, the event envelope, every event type and its payload, and the live-only observation fields.
lastReviewedAt: 2026-07-21
---

This page documents the runtime event surface of `@flue/runtime`: the `observe()` and `instrument()` registration contracts, the `FlueEvent` envelope, every event type and its payload, and the live-only fields a `FlueObservation` adds. For the consumer-oriented walkthrough — subscribing, metering usage, exporting telemetry — see [Observability](/docs/guide/observability/). The per-conversation message stream a chat UI reads is a different surface with a different schema; see the [Streaming Protocol Reference](/docs/reference/streaming-protocol/) and the [Flue Agent SDK events page](/docs/sdk/events/).

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

- **Scope** — isolate-global and live-only. The subscription sees events emitted after registration; there is no durable replay, no history access, and no aggregation across processes. On Node.js one process hosts all agents, so one registration sees everything. On [Cloudflare](/docs/guide/cloudflare-target/), each agent conversation runs in its own Durable Object isolate; a subscriber registered at module top level runs in each isolate and sees that isolate's activity only. [`flue run`](/docs/cli/run/) loads only the agent module, never `app.ts` — a subscriber that must run under the CLI has to be registered in the agent module.
- **Delivery** — subscribers are invoked synchronously on the event emission path, after the runtime's own per-context consumers. Each emission constructs one `FlueObservation` — a deep clone of the event plus observation detail, with reference cycles preserved — deep-freezes it, and delivers that same frozen object to every subscriber.
- **Failure containment** — a subscriber that throws is caught and logged (`console.error` with the `[flue:observe]` prefix); remaining subscribers still run and the originating agent work is unaffected. A returned promise is observed for rejection (logged the same way) but never awaited.
- **Ordering** — events from one emitting context arrive in `eventIndex` order. There is no ordering guarantee across contexts.

The API deliberately does not provide type filtering, backpressure, replay, or any way to mutate or veto an event — subscribers branch on `event.type` and must stay cheap because they run on the emission path.

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

The second subscriber argument: the runtime context of the agent interaction that emitted the event.

- `id` — the agent instance id; equals the `instanceId` stamped on the context's events.
- `agentName` — the registered agent name, when known.
- `env` — platform bindings: `process.env` on Node, the Workers env object on Cloudflare.
- `req` — the invocation's Fetch `Request`, or `undefined` outside an HTTP context. Durable or recovered processing may carry a synthetic internal request instead of the original caller request.
- `log` — emits [`log` events](#log) into this context's event stream. Calling it from inside a subscriber emits further events; guard against loops.

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
- `conversationId`, `session` — present on session-scoped events (turns, messages, tools, operations, compaction, session logs).
- `harness` — the emitting harness name; `"default"` for the root agent harness, the hook's name for lifecycle-hook harnesses.
- `parentSession`, `taskId` — present on events emitted inside a delegated task session.
- `operationId` — present on events emitted inside a running operation.
- `turnId` — present on events emitted during a model turn (in addition to the `turnId` payload field on the turn events themselves).

Ids are opaque generated strings; correlate by equality only.

`FlueEventInput` — the pre-decoration shape (payload plus correlation fields, without `v`/`eventIndex`/`timestamp`) — is internal and not exported; consumers always receive the decorated `FlueEvent`.

Two content guarantees hold for every event surface:

- **No raw image bytes.** Recognized image content blocks in event payloads carry the [`IMAGE_DATA_OMITTED`](#image_data_omitted) sentinel in place of their base64 data. Session history (model context) keeps the real bytes.
- **No throw-site stacks on durable-shaped error fields.** Errors serialized onto `operation`, `compaction`, `log`, and `submission_settled` payloads never include stacks. The classified error shape with an optional `stack` appears in two live-only places: `turn.response.error` and the observation's [`errorInfo`](#flueobservation).

## Event types

The v3 vocabulary contains 24 event types:

- Agent lifecycle — [`agent_start`, `agent_end`, `idle`](#agent_start-agent_end-idle)
- Settlement — [`submission_settled`](#submission_settled)
- Operations — [`operation_start`, `operation`](#operation_start-operation)
- Model turns — [`turn_start`, `turn_request`, `turn`, `turn_messages`](#turn_start-turn_request-turn-turn_messages)
- Messages and deltas — [`message_start`, `message_end`, `text_delta`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_delta`](#message-and-delta-events)
- Tools — [`tool_start`, `tool`](#tool_start-tool)
- Tasks — [`task_start`, `task`](#task_start-task)
- Compaction — [`compaction_start`, `compaction`](#compaction_start-compaction)
- Logs — [`log`](#log)

Nested errors do not necessarily fail the work that contains them: an agent can recover from a failed turn or tool call. `submission_settled` is the reliable terminal signal; `isError` on nested events is diagnostic context.

### `agent_start`, `agent_end`, `idle`

```ts
{ type: 'agent_start' }
{ type: 'agent_end'; messages: AgentMessage[] }
{ type: 'idle' }
```

- `agent_start` — an agent loop run began inside an operation.
- `agent_end` — the loop run ended. `messages` contains the messages that run produced (not the whole transcript). `AgentMessage` is the harness-level message shape (roles `user`, `assistant`, `toolResult`, plus Flue's internal `signal` messages); it is not exported from `@flue/runtime` and is not a stable payload contract — see [Stability](#stable-contract-versus-internal-shapes).
- `idle` — the session finished an operation and returned to idle. Emitted after every terminal `operation` event, on success and failure alike. No payload fields.

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

A durable submission reached a terminal state. Emitted on every terminal path — normal completion, failure, abort, and recovery of an interrupted submission. This is the event to alert on.

- `submissionId` — the settled submission. Also stamped as the envelope correlation field.
- `outcome` — `completed`, `failed`, or `aborted`.
- `error` — present unless `outcome` is `completed`. A [`FlueError`](/docs/reference/errors/) keeps its `name`, `message`, `type`, `details`, and `meta`; any other failure is replaced wholesale by a generic `internal_error` payload — internal error messages never ride this field. The live observation additionally carries the classified [`errorInfo`](#flueobservation), including the throw-site stack.

`submission_settled` is emitted at settlement, outside session scope: it carries the envelope and submission-level correlation fields but no `conversationId`/`session`. Settlement is also recorded durably — a settlement record is appended to the canonical conversation stream (see the [Streaming Protocol Reference](/docs/reference/streaming-protocol/)); the runtime event itself is live-only like every other event.

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

Bounds of one session operation — a `prompt()`, `skill()`, `task()`, `shell()`, or `compact()` call on a session or harness (see the [Agent API Reference](/docs/reference/agent-api/)). Every started operation emits exactly one terminal `operation` event.

- `operationId` — generated per operation; every event emitted inside the operation carries it as a correlation field.
- `durationMs` — wall-clock duration of the operation.
- `isError` / `error` — `error` is present on failure, serialized without stacks: a `FlueError` becomes `{ name, message, type, details?, meta? }`, a plain `Error` becomes `{ name, message }`, and a non-`Error` thrown value passes through as-is.
- `result` — the operation's return value on success (for example a `PromptResponse`). Payloads can be large; exporters should project what they need.
- `usage` — the operation result's aggregated `PromptUsage`, present when the result carries one (`prompt`, `skill`, `task`). Roll-up semantics: `usage` here already includes the operation's `turn`-level usage — sum one level only.

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

- `turn_start` — a model turn began. Emitted for agent-purpose turns only; compaction turns emit `turn_request` and `turn` without a `turn_start`.
- `turn_request` — the full model-visible request, emitted before the provider call. **In-process only:** delivered to `observe()` subscribers but never persisted and never served over any transport. It is the only event that carries the system prompt, the complete message context, and the tool list.
- `turn` — the completed model call: request summary, normalized response, duration, and error status. `isError` is true when the call threw or the response finished with reason `error` or `aborted`.
- `turn_messages` — the turn boundary: the assistant `message` and the `toolResults` its tool calls produced, emitted after any tool batch has durably committed. `toolResults` is empty for a turn without tool calls. Agent-purpose turns only.
- `purpose` — `agent` for conversation turns; `compaction` for a summarization call; `compaction_prefix` for the extra prefix-summarization call a split-turn compaction dispatches.

The normalized `turn` events and the detailed `turn_messages`/`message_*` family describe the same model activity; meter from one family or the other, not both.

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
- `providerName` — the semantic provider identity; differs from `providerId` when a gateway or custom registration fronts the model.
- `requestedModel` — the model id Flue asked for.
- `api` — the wire API the provider speaks.
- `serverAddress`, `serverPort` — parsed from the provider endpoint when available.
- `reasoningLevel`, `maxTokens`, `temperature` — per-call settings, present when set.
- `contextCompacted` — declared in the format for turns whose context was compacted; the current runtime does not populate it.

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

- `responseId`, `responseModel` — provider-reported identity of the response, when reported.
- `output` — the assistant message the call produced, in the exported `Llm` shape.
- `usage` — provider-reported token and cost usage for this single call; absent when the provider reported none. Turn usage is the leaf level — `operation` and `compaction` roll-ups already include it.
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

Token counts per component plus cost computed from the model catalog's per-million-token rates. The cost currency matches the rate's denomination — USD for the built-in registry's commercial providers.

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

- `message_start` / `message_end` — bound every message the agent loop materializes: the user prompt, each assistant message (started with the partial message, ended with the final one), and each tool-result message. For assistant messages, `message_end` carries the authoritative completed message; deltas are best-effort live progress, and a subscriber registered mid-generation misses the deltas emitted before it attached.
- `text_delta` — a streamed fragment of assistant text.
- `thinking_start` / `thinking_delta` / `thinking_end` — bound one streamed reasoning block; `thinking_end.content` is the complete block. `contentIndex` is the zero-based index of the block within the assistant message's content array, when known; correlate thinking events within a turn by `contentIndex`.
- `toolcall_delta` — a streamed fragment of one tool call's JSON-arguments text, for live previews of in-flight calls. Emitted only once the streaming block knows its `toolCallId` and `toolName`. Live-preview only: never persisted, never replayed; the canonical record and the `tool_start` observation remain the source of truth for complete arguments.

Delta events carry no `turnId` payload field; correlate them through the envelope's `turnId` correlation field.

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

- `args` — declared in the format but not populated by the current runtime; the normalized arguments are delivered on the live observation's `args` field instead, and the canonical conversation record carries them durably.
- `isError` — true when the tool threw. Tools signal errors by throwing; there is no error flag on a successful result value.
- `result` — the tool's result value. For model tools this is the harness-level result shape (`content` blocks plus a tool-specific `details` payload) — an internal shape, not a stable contract. Image blocks in `result.content` carry [`IMAGE_DATA_OMITTED`](#image_data_omitted).
- `durationMs` — measured once and shared with the durable record, so the two cannot disagree.

For model-invoked calls the terminal `tool` event is published when the turn's tool batch durably commits, not the instant execution finishes — a tool whose batch is interrupted before commit never publishes its terminal event, matching the durable outcome. `shell()` publishes immediately. `shell()` per-call `env` values are redacted to `<redacted>` in the recorded arguments (keys stay visible); a failed `shell()` carries an error-shaped result whose `details.exitCode` is `-1`.

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
- `result` — the task's assistant text on success; the error message on failure.

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
- `messagesBefore` / `messagesAfter` — live message counts around the compaction.
- `error` — present on failure, in the same serialized shape as [`operation.error`](#operation_start-operation). A failed manual compaction also rejects the `compact()` call; failed automatic compaction is best-effort and only observable here.
- `usage` — aggregated usage of the summarization call(s) the compaction dispatched. Those calls also emit their own `turn_request`/`turn` events with purpose `compaction` or `compaction_prefix`; this roll-up includes them.

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

- `attributes` — caller-supplied structured data, with two normalizations: an `Error` instance under `attributes.error` is serialized to the stackless event-error shape, and the runtime stamps provenance keys — tool logs carry `tool` and `toolCallId`, hook logs carry `hook` and `hookIndex`.

Log events are runtime events only: the model never sees them and they never appear in the conversation a client renders.

### Event order

Within one `prompt` operation containing a single tool-calling turn, events arrive in this order:

1. `operation_start`, `agent_start`
2. `message_start` / `message_end` for the user message
3. `turn_start`, `turn_request`
4. `message_start` for the assistant message; `text_delta`, `thinking_*`, and `toolcall_delta` interleave while it streams
5. `turn`, then `message_end` for the completed assistant message
6. per tool call: `tool_start` when execution begins, then `message_start` / `message_end` for its tool-result message when it finishes
7. the terminal `tool` events when the batch commits, then `turn_messages`
8. further turns repeat from step 3 until a turn produces no tool calls
9. `agent_end`, `operation`, `idle`
10. `submission_settled` when the submission settles

The sequence describes the uncontended path. A delivery that joins an already-busy conversation can interleave additional user `message_start` / `message_end` pairs at turn boundaries.

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

The shape `observe()` delivers: the event plus exporter-oriented detail fields. Every detail field is **live-only** — never persisted, never replayed, and never present on any transported event. The detail fields:

- `agentInput` — the invocation's prompt text and image manifest (MIME types only, no bytes). On the terminal `operation` event for `prompt` and `skill` operations, and on `task_start`.
- `agentOutput` — the invocation's outcome: freeform text with its finish reason, or the validated structured data of a `result:`-schema call. On successful `operation` (`prompt`/`skill`) and `task` events.
- `origin` — who initiated a tool call: `model` (model-invoked, including custom tools), `adapter` (sandbox-adapter tools), `framework` (framework-added tools such as `task` and result extraction), or `caller` (programmatic `shell()`). On `tool_start` and `tool`.
- `description` — the tool's description text. On `tool_start` and `tool` for model-invoked calls.
- `args` — the tool call's normalized arguments. On `tool_start`.
- `effectiveResult` — the tool's effective result as the model sees it (single text blocks collapsed to their string). On successful `tool` events. Image content is replaced with [`IMAGE_DATA_OMITTED`](#image_data_omitted).
- `toolCallId` — on `task_start` when the task was raised by a model `task` tool call, linking the task to that call.
- `errorInfo` — the classified error for a failed activity (`operation`, `tool`, `task`, `compaction`, `submission_settled`; failed turns carry the same shape as `turn.response.error` instead). `type` is the stable machine-readable category (a [`FlueError`](/docs/reference/errors/)'s `type`, else the error's `code`, `name`, or `_OTHER`); `meta` is framework-owned structured metadata (for example validation issues); `stack` is the throw-site stack, present only when the failure was observed live from a thrown `Error`. Stacks expose filesystem paths and deployment layout, which is why this projection exists only in process.

Observations are deep-frozen; treat them as read-only.

`FlueObservationDetail` (the detail-fields object) and `FlueErrorInfo` are not exported as standalone types — consume them through `FlueObservation`.

## `IMAGE_DATA_OMITTED`

```ts
const IMAGE_DATA_OMITTED = '[image data omitted from event]';
```

The sentinel that replaces raw base64 image bytes in every event payload: message-bearing fields on `message_start`, `message_end`, `turn_messages`, and `agent_end`; `tool` results; `turn_request`/`turn` message content; and the observation's `effectiveResult`. Events keep an image's presence and `mimeType` visible without carrying the payload. Session history and canonical attachments retain the real bytes for model context; only events are redacted. The constant is exported from both `@flue/runtime` and `@flue/sdk`.

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

Installs an instrumentation bundle: an event subscriber (registered exactly as `observe()` would) paired with an [execution interceptor](#flueexecutioninterceptor) that wraps live agent, model, tool, and task execution — the registration used by tracing adapters such as [`@flue/opentelemetry`](/docs/ecosystem/tooling/opentelemetry/). Returns a dispose function.

- `key` — optional identity symbol. While an instrumentation with a given key is installed, installing another with the same key throws `InstrumentationAlreadyInstalledError` (a `FlueError` with `type: 'instrumentation_already_installed'`) in production; in dev the newest install wins and the prior one is disposed, which is what makes module-scope installations safe across dev-server reloads. Adapters use this to prevent double installation.
- `observe` — receives every event, with the same delivery, containment, and ordering contract as [`observe()`](#observe).
- `interceptor` — joins the process-wide interceptor chain for the duration of the installation.
- `dispose` — the bundle's own teardown (flush exporters, shut down providers). Called by the returned dispose function after the subscriber and interceptor are unregistered.

The returned dispose function is memoized and idempotent: calling `instrument()` again with the same object returns the same function without reinstalling, and repeated calls to the function share one disposal. On the Node target, a module-scope installation is not disposed at server shutdown — an integration that must flush on exit should register its own signal handling — and survives dev-server reloads through key replacement, not disposal by the server. On Cloudflare, installations live and die with their isolate. A manually retained dispose function is only needed for dynamic wiring.

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

Middleware around live execution, registered through [`instrument()`](#instrument). Registered interceptors compose in registration order; each receives a `next` continuation for the rest of the chain and the wrapped work itself.

- **Wrapped operations** — `agent` wraps a submission run and each `prompt`/`skill` session operation (`operationId` is the submission id at submission scope with `operationKind: 'prompt'`, the operation id at session scope; the declared `operationKind: 'task'` is not raised by the current runtime, which represents delegation with the `task` operation type); `model` wraps each provider call, correlated to the `turn` events by `turnId`; `tool` wraps each tool execution; `task` wraps each delegated task. Scopes nest: a `model` interception runs inside its enclosing `agent` interception's async context, which is what lets a tracer parent spans without any Flue-specific propagation.
- **`next` is exactly-once** — calling it a second time rejects with an `Error` (`"Flue execution next() called more than once."`). Not calling it skips the wrapped work and the rest of the chain; the interceptor's return value becomes the operation's result.
- **`ctx` fields** — populated when known at the interception point: submission scope carries `instanceId`, `submissionId`, `agentName`, and `traceCarrier`; session scope carries `instanceId`, `harness`, `conversationId`, `session`, `operationId`, and, when active, `turnId` and `taskId`. `traceCarrier` is the validated W3C `traceparent`/`tracestate` pair extracted from the originating HTTP request, when one carried it. `eventContext` is declared in the type but not populated by the current runtime.

Interceptors run on the execution path: a slow interceptor slows the agent, and a throwing interceptor fails the wrapped operation.

## `AttachedAgentEvent`

```ts
type AttachedAgentEvent = FlueEvent & {
  instanceId: string;
};
```

A `FlueEvent` from a direct attached-agent interaction, with `instanceId` required rather than optional. A typing convenience for consumers of per-instance live streams; attached-agent events are live activity, not durable history.

## Stable contract versus internal shapes

Stable, exported from `@flue/runtime`:

- The event envelope (`v`, `eventIndex`, `timestamp`) and correlation fields.
- The event type names and the payload fields shown on this page.
- `ModelRequest`, `ModelRequestInput`, `ModelRequestInfo`, `ModelResponse`, `PromptUsage`, `LlmTurnPurpose`, and the `Llm*` message and tool types — the model-turn payloads are fully typed by exported symbols.
- `IMAGE_DATA_OMITTED`.

Internal shapes that ride event payloads without a stability guarantee:

- `AgentMessage` values on `message_start`, `message_end`, `turn_messages`, and `agent_end` — the harness-level message representation, including internal roles. Consume completed model output through `turn.response.output` (typed by `LlmAssistantMessage`) instead where possible.
- `tool.result` and the observation's `effectiveResult` — tool-shaped values whose `details` payload is tool-specific by design.
- `operation.result` — the operation's return value, whose shape follows the operation.

Format changes that break the stable surface bump `v`; additive optional fields do not.
