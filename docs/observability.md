# Observability

Flue exposes a vendor-neutral execution event stream for error reporting, tracing, metrics, and external evaluation systems.

```ts
import { observe } from '@flue/runtime/app';

observe((event, ctx) => {
  // Forward selected Flue execution telemetry to your system.
});
```

Register observers at module scope in `app.ts`. On Node, one subscriber registration observes the process's Flue execution. On Cloudflare, `app.ts` is evaluated independently in each isolate, so each Durable Object observes its own activity.

## Lifecycle model

Workflows and agents have different lifetimes:

- A **workflow run** is finite and emits `run_start` / `run_end`, correlated by `runId`.
- An **agent instance/session** is persistent and may process many inputs over time. Direct prompts and dispatched inputs do not create runs.
- An **operation** is one finite Flue action, such as `prompt`, `skill`, `task`, `shell`, or `compact`. Direct and dispatched input processing are prompt operations.
- An **agent loop** is the Pi-aligned `agent_start` / `agent_end` processing cycle inside an operation that invokes the model.
- A **turn** is one model decision cycle. One prompt operation may contain multiple turns when the model invokes tools.
- `idle` means current work has settled and the session is waiting; it does not terminate a persistent session.

```text
workflow only
run_start
  operation_start
    agent_start
      turn_start -> turn_request -> model/message/tool events -> turn_end -> turn
    agent_end
  operation
run_end

persistent direct or dispatched input
operation_start
  agent_start
    turn_start -> turn_request -> model/message/tool events -> turn_end -> turn
  agent_end
operation
idle
```

## Correlation fields

| Field | Meaning |
| --- | --- |
| `runId` | Finite workflow invocation only. |
| `instanceId` | Persistent agent instance identity for direct/dispatched processing. |
| `dispatchId` | Asynchronously admitted dispatched input identity. |
| `harness` / `session` | Initialized environment and persistent conversation. |
| `operationId` | One finite Flue operation or processed inbound input. |
| `taskId` / `parentSession` | Child task/subagent relationship. |
| `turnId` | One model-facing request/response cycle inside an operation. |

For workflow traces, use `runId` as the root and nest operations below it. For direct or dispatched persistent-agent activity, use `operationId` as the finite trace root and retain `instanceId`, `session`, and optional `dispatchId` as correlation attributes.

## Model turn events

A model-using operation exposes Pi lifecycle and a Flue-normalized request/response pair:

| Event | Purpose |
| --- | --- |
| `turn_start` | Pi-aligned logical start of an agent-loop model turn; establishes `turnId`. |
| `turn_request` | Exact normalized model-visible request at the provider boundary, including compaction model calls. |
| `turn` | Normalized terminal output, usage, timing, and failure state. |

`turn_request` is emitted after Flue/Pi has resolved the model-visible context for that provider request. It includes:

- model, provider, and API identity;
- effective reasoning setting, when present;
- system prompt;
- messages visible to the model;
- model-visible tool definitions without executable functions.

The terminal `turn` event includes the same `turnId`, the normalized assistant output, model/provider/API identity, duration, usage/cost, stop reason, and error state. `turn_request` and `turn` include a `purpose` field: normal agent-loop calls use `agent`, while summarization calls performed during context management use `compaction` or `compaction_prefix`. Compaction requests do not emit Pi `turn_start` because they execute outside Pi's agent loop.

Tool and streamed-output events emitted while an agent-loop turn is active carry the originating `turnId`, allowing an exporter to reconstruct a timeline such as:

```text
operation: prompt
  turn: input -> requests lookup tool
  tool: lookup
  turn: input with lookup result -> final answer
```

## Content and sensitive data

Flue's event stream is content-bearing. Existing events can include workflow payloads/results, messages, generated text, thinking content, tool arguments/results, task prompts/results, logs, and operation results. `turn_request` and enriched terminal `turn` events make the exact normalized model request/output available to observers as well.

Treat event export and persisted workflow run events as potentially sensitive:

- Do not forward all events to a third party unless that retention and access model is acceptable for your application.
- Filter or redact content in your observer when exporting only operational metadata is appropriate.
- `session.shell(command, { env })` redacts environment values in its recorded tool representation; this does not guarantee that arbitrary tool output or model output excludes secrets.
- Workflow event persistence stores full-fidelity events subject to a 1 MB per-event limit; very large content-bearing events may make workflow persistence fail rather than silently store incomplete telemetry.

A future observability-content configuration may provide framework-level filtering controls. Until then, enabling an external exporter is an explicit decision to handle event content responsibly.

## Integration guidance

An external observability adapter can map public events as follows:

| Flue events | External trace concept |
| --- | --- |
| `run_start` / `run_end` | Workflow root span |
| `operation_start` / `operation` | Flue operation span; root span for direct/dispatched processing |
| `agent_start` / `agent_end` | Optional active agent-loop span |
| `turn_start` / `turn_request` / `turn` | LLM generation span |
| `tool_start` / `tool_call` | Tool span |
| `task_start` / `task` | Child task/subagent span |
| `compaction_start` / `compaction` | Compaction span |
| `log` | Log, breadcrumb, or error reporting event |

`observe(...)` supplies complete Flue-level semantics. A vendor may separately provide Node-specific wrapping or provider-SDK auto-instrumentation when it wants provider-native spans to inherit an active vendor span context during execution. Those optional capabilities are not required to understand Flue execution and should not require application code to depend on `@flue/runtime/internal`.

See `examples/sentry/` for a public `observe(...)` integration focused on error reporting.
