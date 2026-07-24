# OpenTelemetry for Flue

`@flue/opentelemetry` projects Flue runtime observations into the OpenTelemetry GenAI semantic conventions pinned at commit `4c8addb53718b544134be47e256237026fe88875`.

## Usage

Configure an OpenTelemetry SDK and exporter first, then register the instrumentation once:

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

const instrumentation = createOpenTelemetryInstrumentation();
const dispose = instrument(instrumentation);
```

Generated Node applications automatically dispose registrations created while evaluating `app.ts` after admissions and active work drain. Call `await dispose()` yourself only when registering outside that lifecycle. Disposal unregisters the observation subscriber and execution interceptor and ends remaining local spans. Flush or shut down the application-owned OpenTelemetry SDK separately.

Pass application-owned tracer, meter, or logger instances when needed:

```ts
const instrumentation = createOpenTelemetryInstrumentation({
  tracer,
  meter,
  logger,
});
```

## Semantic model

| Flue boundary          | OpenTelemetry representation                                   |
| ---------------------- | -------------------------------------------------------------- |
| Prompt or skill        | `invoke_agent <agent>` internal span                           |
| Delegated task         | one task-owned `invoke_agent <agent>` internal span            |
| Provider inference     | `chat <requested-model>` client span                           |
| GenAI tool execution   | `execute_tool <name>` internal span                            |
| Caller shell execution | `flue.operation shell` internal span                           |
| Context compaction     | `flue.compaction` internal span with standard child chat spans |

A provider chat span measures provider inference only. Tool spans are siblings under the owning agent invocation and correlate with model output through `gen_ai.tool.call.id`.

`gen_ai.conversation.id` is the persisted opaque Flue session identity. Submission, dispatch, operation, trace, session-name, and provider-affinity values never substitute for it.

## Content capture

Content capture is disabled by default. Implemented model-message, system-instruction, tool-definition, tool-description, argument/result, exception-message, and external-content paths receive no raw content in this mode.

Enable one instrumentation-wide policy and redact before export:

```ts
const instrumentation = createOpenTelemetryInstrumentation({
  content: {
    enabled: process.env.OTEL_GENAI_CAPTURE_CONTENT === 'true',
    transform(content) {
      return redactSecrets(content);
    },
  },
});
```

The master `enabled` value is the privacy ceiling. One detached copy passes through `transform`; returning `undefined` suppresses both destinations. Transforms are trusted application code: Flue does not validate their returned GenAI shape. After transformation, `maxMessageParts` retains the first complete parts in every input/output message and the first top-level system instructions, while `maxToolDefinitions` retains the first definitions. Limits must be finite nonnegative safe integers.

`externalContent` is a side-effect-only sink for system instructions and input/output messages. It receives a detached, structurally limited clone plus a stable `contentType` scope before inline recording, regardless of sampling or `inline`. Its return value and mutations are ignored, failures only produce safe diagnostics, and tool definitions, descriptions, arguments, and results are never delivered to it.

Set `inline: false` to skip serialization while retaining external delivery. `maxAttributeBytes` applies only to the exact final UTF-8 inline attribute string. Object-shaped tool arguments/results use standard `gen_ai.tool.call.*` attributes; other useful values use `flue.tool.call.arguments` or `flue.tool.call.result` under the same privacy and size policy. Tool descriptions and plain-text fallbacks remain raw strings. Structural truncation and byte omission are marked with bounded `flue.telemetry.content.*` attributes. Flue does not flatten undeclared child keys beneath `gen_ai.*`.

## Metrics and Logs

The instrumentation emits these applicable metrics:

- `gen_ai.client.operation.duration`;
- `gen_ai.client.token.usage`;
- `gen_ai.invoke_agent.duration`;
- `gen_ai.execute_tool.duration`.

Metric attributes exclude conversation, submission, dispatch, operation, turn, task, and tool-call IDs. Input token totals include cache-read and cache-creation input tokens.

Logs are optional and require explicit structural Logger injection. Failed inference operations emit `gen_ai.client.operation.exception` at WARN/13. Error type is always recorded; transformed exception messages are included only when content capture is enabled. Traces and metrics work without a Logger.

## Propagation and recovery

Flue validates and persists `traceparent` plus optional `tracestate` at direct-agent admission. Baggage is not persisted. Durable direct-agent execution activates its extracted admission context. `dispatch(...)` does not currently propagate trace context.

A restarted execution cannot keep an in-memory span open. Recovery does not replay provider or tool execution. Replayed stream chunks do not create chat spans or usage metrics, and synthetic interrupted-tool repairs do not create tool spans.

## Current limitation

Pi does not currently expose authoritative raw provider stream-item lifecycle callbacks. Flue therefore does not emit `gen_ai.client.operation.time_to_first_chunk` or `gen_ai.client.operation.time_per_output_chunk`; semantic text/reasoning deltas and recovered chunks are not valid substitutes.

## Breaking migration

Replace `createOpenTelemetryObserver()` with `createOpenTelemetryInstrumentation()`, replace `observe(...)` registration with `instrument(...)`, and replace the per-event `exportContent` callback with the global `content` policy. The old API and custom `flue.turn.*`/`flue.tool.*` content attributes are not emitted in parallel.

## Unsupported operations

Flue does not fabricate GenAI operations for agent creation, planning, embeddings, retrieval, memory CRUD/search, remote agent clients, or evaluations. These remain absent until Flue has genuine corresponding API boundaries.
