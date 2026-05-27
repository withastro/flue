---
title: Observability
description: Inspect execution, emit structured logs, and connect Flue events to monitoring and tracing tools.
---

Observability helps you answer practical questions about a Flue application:

- Did a workflow finish successfully? If not, where did it fail?
- Which agent operation or tool made a response slow?
- How many model turns did a prompt need, and what did they cost?
- What happened after an inbound event was dispatched to a persistent agent session?

Flue exposes three complementary surfaces:

1. **Workflow run history** for finite, persisted workflow executions.
2. **Structured application logs** emitted through a workflow context.
3. **`observe(...)` events** for cross-cutting logging, metrics, tracing, and error reporting across workflows and agent interactions.

Start with `observe(...)` and log only the terminal or diagnostic events you need. Add run-history inspection for workflows and an external telemetry exporter when operations need durable debugging, metrics, or tracing.

## Start with `observe(...)`

Add an `app.ts` entry to your Flue project and register an observer at module scope:

```ts title=".flue/app.ts"
import { flue, observe } from '@flue/runtime/app';
import { Hono } from 'hono';

observe((event) => {
  if (event.type === 'run_end') {
    console.log('[workflow]', event.runId, event.isError ? 'failed' : 'completed');
  }

  if (event.type === 'operation' && event.durationMs > 5_000) {
    console.warn('[slow operation]', event.operationKind, event.durationMs);
  }

  if (event.type === 'log' && event.level === 'error') {
    console.error('[application error]', event.message, event.attributes);
  }
});

const app = new Hono();
app.route('/', flue());

export default app;
```

Import `observe` from `@flue/runtime/app`. This is Flue's public integration point for application-wide telemetry: it works for a console reporter, a metrics sink, an error reporter, or a trace exporter.

The callback receives a decorated `FlueEvent` and its originating context:

```ts
observe((event, ctx) => {
  console.log(event.type, ctx.id, event.timestamp);
});
```

Observers run synchronously while an event is emitted. Keep the callback lightweight: filter events, record counters, or enqueue exporter work, but do not block application execution. If an observer throws, Flue logs the observer error and continues the original work.

### Where registration runs

On the **Node** target, module-scoped registration observes activity handled by that server process.

On the **Cloudflare** target, each isolate evaluates `app.ts` independently. An agent Durable Object therefore registers its own observer and exports its own activity. Do not rely on shared module state to aggregate telemetry across Durable Objects; export events to your external system instead.

## Lifecycle overview

Correct correlation starts with understanding what Flue considers finite. A workflow is a bounded invocation with a persisted run history. An agent instance is persistent: each direct prompt or dispatched input performs finite work in a session, but does not create a workflow run.

```text
workflow invocation
  │
  ├─► run_start { runId }
  │
  │   ┌── session operation (zero or more) ────────────────┐
  │   │                                                     │
  │   ├─► operation_start { operationId, operationKind }    │
  │   │     ├─► agent_start                                 │
  │   │     │     ┌── model turn (repeats) ─────────────┐   │
  │   │     │     ├─► turn_start                       │   │
  │   │     │     ├─► turn_request                     │   │
  │   │     │     ├─► message and tool activity        │   │
  │   │     │     ├─► turn_end                         │   │
  │   │     │     └─► turn                             │   │
  │   │     └─► agent_end                                   │
  │   ├─► operation { operationId }                         │
  │   └─► idle                                              │
  │                                                         │
  └─► run_end { runId }


direct agent prompt
  │
  ├─► operation_start { instanceId, operationId, operationKind: 'prompt' }
  ├─► agent_start ─► model turns and tools ─► agent_end
  ├─► operation { instanceId, operationId }
  └─► idle { instanceId }


dispatch(...) ─► { dispatchId, acceptedAt }
  │
  └── asynchronously:
      ├─► operation_start { instanceId, dispatchId, operationId, operationKind: 'prompt' }
      ├─► agent_start ─► model turns and tools ─► agent_end
      ├─► operation { instanceId, dispatchId, operationId }
      └─► idle { instanceId, dispatchId }
```

`run_start`, `run_resume`, and `run_end` are emitted only for workflows. `run_resume` appears when durable recovery continues an already-started run in a new execution context. `idle` means that current operation processing has settled and the session is ready for more input; it is not the end of an agent instance or session.

### Root lifecycle by invocation kind

| Invocation kind | Trace root | Opening and closing events | Persisted run history | Observation surface |
| --- | --- | --- | --- | --- |
| Workflow invocation | `runId` | `run_start` or recovery `run_resume` / `run_end` | Yes | `observe(...)`, run APIs, `flue logs`, workflow streams |
| Direct agent prompt | `operationId`, with `instanceId` | `operation_start` / `operation`, then `idle` | No | `observe(...)` and attached HTTP/WebSocket streams |
| Dispatched agent input | `operationId`, with `instanceId` and `dispatchId` | `operation_start` / `operation`, then `idle` | No | `observe(...)` |

`dispatch(...)` returns a receipt when input is accepted for asynchronous processing; it does not return a caller-attached event stream.

### Correlation identifiers

| Field | Use it for |
| --- | --- |
| `runId` | One finite workflow invocation. Workflow events correlate through this root identity. |
| `instanceId` | One persistent agent instance handling direct or dispatched input; also present on workflow start identity. |
| `session` / `harness` | Conversation and initialized agent-environment scopes for session-derived events. |
| `dispatchId` | One asynchronously accepted dispatched input and the processing it triggers. |
| `operationId` | One finite session action: `prompt`, `skill`, `task`, `shell`, or explicit `compact`. |
| `taskId` / `parentSession` | Delegated child-agent work and its originating session. |
| `turnId` | One normalized model request/output pair within agent or compaction work. |
| `eventIndex` / `timestamp` | Ordering within one emitted context and event time. |

Use `runId` as the root for a workflow trace. For direct or dispatched agent processing, use `operationId` as the finite trace root and retain `instanceId`, `session`, and `dispatchId` as attributes. When a durable workflow attempt replaces an interrupted attempt, `run_start.restartedFromRunId` carries the prior run identity for trace linking. When the same workflow run is recovered after an interrupted execution context, `run_resume` lets isolate-local exporters begin a resumed workflow segment for the existing `runId`.

## Event reference

`FlueEvent` covers the workflow envelope, operations within sessions, model work, tools, delegated tasks, compaction, application logs, and settled processing.

| Category | Events | Emitted when |
| --- | --- | --- |
| Workflow envelope | `run_start`, `run_resume`, `run_end` | Workflow invocations only; `run_resume` signals durable recovery continuing in a new execution context. |
| Operation lifecycle | `operation_start`, `operation`, `idle` | Session operations, including direct and dispatched prompts. |
| Agent loop | `agent_start`, `agent_end` | Model-driven prompt, skill, or delegated task processing. |
| Ordinary turn lifecycle | `turn_start`, `turn_end` | Agent-loop model turns only. |
| Model telemetry | `turn_request`, `turn` | Agent turns and internal compaction model calls. |
| Message streaming | `message_start`, `message_update`, `message_end` | Message activity inside the ordinary agent loop. |
| Streamed content | `text_delta`, `thinking_start`, `thinking_delta`, `thinking_end` | Assistant text or reasoning projections when present. |
| Tool execution | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Tools invoked from an agent-loop turn. |
| Normalized tool span | `tool_start`, `tool_call` | Agent-loop tools, `session.shell(...)`, and `harness.shell(...)`. |
| Delegated task span | `task_start`, `task` | Child-agent work performed through `session.task(...)` or the task tool. |
| Compaction span | `compaction_start`, `compaction` | Context compaction when compaction work is performed. |
| Diagnostics | `log` | Application-authored logs and runtime diagnostic logs. |

### Operations

Every session operation has a finite boundary:

```text
operation_start { operationKind }
  operation-specific events
operation { isError, durationMs, result?, usage?, error? }
idle
```

| Operation kind | Trigger | Typical nested activity |
| --- | --- | --- |
| `prompt` | `session.prompt(...)`, direct agent input, dispatched input | Agent turns, tools, tasks, automatic compaction. |
| `skill` | `session.skill(...)` | Agent turns, tools, tasks, automatic compaction. |
| `task` | `session.task(...)` | `task_start`, child-session operations, `task`. |
| `shell` | `session.shell(...)` | Normalized bash `tool_start` / `tool_call`, without model turns. |
| `compact` | Explicit `session.compact()` | Compaction work, when the session has content to compact. |

Automatic threshold or overflow compaction remains nested within its current prompt or skill operation. Only explicit `session.compact()` creates an operation with `operationKind: 'compact'`.

### Model turns

One prompt operation can perform several ordinary model turns, especially when the model invokes tools:

```text
turn_start { purpose: 'agent', turnId }
turn_request { purpose: 'agent', turnId }
  message_start
  message_update ─► text_delta / thinking_* events
  message_end
  tool activity, when requested
turn_end { purpose: 'agent', turnId }
turn { purpose: 'agent', turnId, usage, durationMs, isError }
```

`turn_request` exposes normalized model-visible input. `turn` exposes normalized output, duration, usage and cost, stop reason, and failure state. Use their shared `turnId` to create one model-generation trace span.

### Tool events

Flue exposes raw agent-loop tool progress and normalized completed tool spans:

| Event family | Use it for | Model-invoked tools | `session.shell(...)` | `harness.shell(...)` |
| --- | --- | ---: | ---: | ---: |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Incremental tool execution activity. | Yes | No | No |
| `tool_start` / `tool_call` | Duration, result, and error span mapping. | Yes | Yes | Yes |

`harness.shell(...)` emits a harness-correlated bash tool span without a session operation because it intentionally runs outside conversation state. When an agent invokes several tools concurrently, execution-update and terminal events may interleave. Match tool activity by tool-call identity rather than assuming sequential ordering.

### Delegated tasks

A task creates child-session activity inside the parent task operation:

```text
operation_start { operationKind: 'task' }
  task_start { taskId, parentSession }
    operation_start { operationKind: 'prompt', taskId, parentSession }
      agent_start ─► model turns and tools ─► agent_end
    operation
    idle
  task { taskId, parentSession }
operation
idle
```

Use `taskId` and `parentSession` to nest delegated work beneath the parent operation while retaining the surrounding workflow or persistent-agent trace root.

### Compaction

Context compaction has its own span and can make internal model calls:

```text
compaction_start { reason }
  turn_request { purpose: 'compaction' | 'compaction_prefix', turnId }
  turn { purpose: 'compaction' | 'compaction_prefix', turnId }
compaction
```

Compaction model calls emit `turn_request` and `turn`, but do not emit ordinary agent-loop `turn_start`, `turn_end`, message-stream, or tool-execution events. Automatic compaction is nested within the active operation; explicit `session.compact()` wraps it in a `compact` operation. An explicit compact call with nothing to summarize may complete without emitting `compaction_start` or `compaction`.

## Add application logs

Within a workflow, use `ctx.log` to emit structured diagnostic events alongside its run history:

```ts title=".flue/workflows/summarize.ts"
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = createAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));

export async function run(ctx: FlueContext) {
  ctx.log.info('summarization started', { documentType: 'report' });

  try {
    const harness = await ctx.init(agent);
    const session = await harness.session();
    const response = await session.prompt('Summarize the report.');

    ctx.log.info('summarization complete', {
      tokens: response.usage.totalTokens,
      cost: response.usage.cost.total,
    });

    return { summary: response.text };
  } catch (error) {
    ctx.log.error('summarization failed', { error });
    throw error;
  }
}
```

`info`, `warn`, and `error` events accept structured attributes. Prefer attributes for values you will search, aggregate, or forward to monitoring tools.

During workflows, `ctx.log` events are persisted with the run. Runtime diagnostic `log` events emitted during persistent-agent activity are observable through attached streams and `observe(...)`, but they are not workflow run history because agent processing is not a run.

## Inspect workflow runs locally

Workflow events are persisted and inspectable after invocation. `flue run` reports the run identifier for the workflow it invokes; use that identifier with `flue logs`:

```bash
flue logs <workflowRunId> --server http://localhost:3583
```

Follow an active workflow run:

```bash
flue logs <workflowRunId> --server http://localhost:3583 --follow
```

Limit the stream to selected lifecycle signals or consume machine-readable events:

```bash
flue logs <workflowRunId> --types log,operation,turn,run_end --format ndjson
```

`flue logs` applies to workflows only. For direct HTTP/WebSocket prompts or dispatched agent inputs, use the attached event stream, your `observe(...)` integration, and the agent correlation fields above.

## Consume run events programmatically

For an operations dashboard or automated diagnostic process, use `@flue/sdk` to stream workflow activity:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });

for await (const event of client.runs.stream(runId)) {
  if (event.type === 'log') {
    console.log(event.level, event.message, event.attributes);
  }

  if (event.type === 'turn') {
    console.log(event.model, event.usage?.totalTokens, event.durationMs);
  }
}
```

Direct attached-agent streams and WebSocket connections expose the same agent lifecycle activity without assigning workflow run identity. This makes them useful for interactive UIs, while `observe(...)` remains the application-wide integration point.

## Trace model work, tools, and tasks

A single `session.prompt(...)` may perform multiple model turns, especially when tools are involved. Flue exposes a normalized model-turn pair for exporters and debugging tools:

| Event | Meaning |
| --- | --- |
| `turn_start` | A Pi-aligned agent-loop turn began. |
| `turn_request` | The normalized request about to be sent to the model. |
| `turn` | The normalized terminal model output, timing, usage, and failure state. |

`turn_request` and `turn` share a `turnId`. `turn_request` includes the model/provider/API identity, effective reasoning setting when present, model-visible messages, system prompt, and available tool definitions. `turn` includes normalized assistant output, duration, usage/cost, stop reason, and error status.

For example, an exporter can represent a tool-using prompt as:

```text
operation: prompt
  llm turn: asks to call lookup_weather
    tool: lookup_weather
  llm turn: reads tool result and returns an answer
```

Model calls used for context compaction are also visible. They carry `purpose: 'compaction'` or `purpose: 'compaction_prefix'`, rather than appearing as ordinary agent decisions. Ordinary agent-loop turns carry `purpose: 'agent'`.

A useful span mapping is:

| Flue lifecycle events | Trace concept |
| --- | --- |
| `run_start` / `run_resume` / `run_end` | Workflow root span or resumed workflow segment |
| `operation_start` / `operation` | Operation span; root for direct/dispatched input processing |
| `agent_start` / `agent_end` | Optional agent-loop span |
| `turn_request` / `turn` | LLM generation span |
| `tool_start` / `tool_call` | Tool span |
| `task_start` / `task` | Delegated task span |
| `compaction_start` / `compaction` | Context-compaction span |
| `log` | Breadcrumb, log event, or error signal |

## Forward failures to an error reporter

Error reporting does not require tracing every event. A simple integration can capture unhandled workflow failures and explicit application error logs:

```ts title=".flue/app.ts"
import { flue, observe } from '@flue/runtime/app';
import { Hono } from 'hono';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
});

observe((event) => {
  if (event.type === 'run_end' && event.isError) {
    Sentry.captureException(event.error);
  }

  if (event.type === 'log' && event.level === 'error') {
    Sentry.captureMessage(event.message, 'error');
  }
});

const app = new Hono();
app.route('/', flue());
export default app;
```

Start narrowly. Model and tool errors may be recovered within an agent loop; exporting every recoverable failure as an incident can produce noisy alerts. Use terminal workflow failures and deliberate `ctx.log.error(...)` calls as a sensible baseline.

See the [`examples/sentry/`](https://github.com/withastro/flue/tree/main/examples/sentry) project for a complete error-reporting integration.

## Export traces to an observability platform

Use the OpenTelemetry adapter when your application already configures an OpenTelemetry SDK and exporter:

```ts title=".flue/app.ts"
import { createOpenTelemetryObserver } from '@flue/opentelemetry';
import { flue, observe } from '@flue/runtime/app';
import { Hono } from 'hono';

observe(createOpenTelemetryObserver());

const app = new Hono();
app.route('/', flue());
export default app;
```

The adapter maps workflow runs, recovered workflow segments, operations, model turns, tools, tasks, compaction, and logs into spans and span events. It exports correlation, latency, terminal error messages, model, and token/cost metadata by default. Set `captureContent: true` only if your exporter should receive payloads, results, prompts, outputs, task content, tool arguments/results, and log attributes.

For a provider-specific integration, translate correlated events into your provider's spans. The [`examples/braintrust/`](https://github.com/withastro/flue/tree/main/examples/braintrust) project demonstrates a public `observe(...)`-only bridge that creates:

- workflow root spans;
- operation, task, and compaction spans;
- model-generation spans with request/output and token/cost data;
- nested tool spans.

`@flue/opentelemetry` and the Braintrust example both consume only the public `observe(...)` event model. `observe(...)` gives an adapter the Flue-level execution semantics. A vendor may separately use provider SDK instrumentation or Node-specific wrappers when it needs live async context for provider-native spans; application code does not need to depend on private Flue runtime internals to understand the Flue trace.

## Handle sensitive content carefully

Flue events may contain substantial application and model data, including:

- workflow payloads and returned results;
- application log attributes;
- system prompts and model-visible messages;
- model output and supported thinking content;
- tool arguments and results;
- delegated task prompts and results;
- images and other large encoded content.

`turn_request` and `turn` intentionally provide full-fidelity model telemetry. Before sending events to an external service:

- choose which event types and fields you need;
- remove or redact secrets and personal data;
- confirm your provider's data retention and access controls;
- avoid exporting content at all when aggregate duration, error, token, and cost metrics are sufficient.

`session.shell(command, { env })` redacts environment values in its recorded tool representation, but arbitrary tool results or model output may still contain sensitive values.

Workflow event history persists full-fidelity events subject to a **1 MB per-event limit**. Very large content-bearing events may cause workflow persistence to fail rather than silently store incomplete telemetry.

## Recommended progression

A practical observability setup can grow in stages:

1. **Local development:** log selected `observe(...)` events to the console and inspect workflows with `flue logs`.
2. **Production diagnostics:** emit structured `ctx.log` events and forward terminal failures to an error reporter.
3. **Operational monitoring:** derive latency, token, cost, and error metrics from terminal operation and model-turn events.
4. **Full tracing:** configure an OpenTelemetry exporter with `@flue/opentelemetry`, or map operations, turns, tools, tasks, and compactions to spans in another tracing backend.

Start with the questions your application needs answered, and add telemetry only where it helps you debug, monitor, or improve behavior.
