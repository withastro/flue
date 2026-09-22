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

**Content is enabled by default** — model messages, reasoning, system instructions, tool definitions, arguments/results, and exception messages and stack traces all ship as span attributes. The explicit `instrument(...)` call is the consent (a deliberate deviation from the wider OTel GenAI convention of content off behind an env-var opt-in). Review the receiving backend's retention and access controls, and apply one of the two controls below before exporting to a backend not cleared for conversation data.

```ts
// content-free spans
const instrumentation = createOpenTelemetryInstrumentation({ content: false });

// policy in code
const instrumentation = createOpenTelemetryInstrumentation({
  content: {
    transform(content, scope) {
      if (scope.contentType === 'exception_stacktrace') return undefined; // strip stacks
      return redactSecrets(content);
    },
  },
});
```

A detached converted value passes through `transform` once per content type; returning `undefined` omits that content, and a throwing transform emits a `[flue]` failure sentinel instead of the unredacted value. `scope` carries the content type, event type, execution identity, and `traceId`/`spanId`. For byte budgets, slice inside the transform or use the exported `truncateContent(content, { maxBytes })`. After the transform, a 56 KiB per-span content budget is enforced **in-band** (default, sized to workerd's 64 KiB span-attribute cap): everything content-bearing a span carries — messages, system instructions, tool definitions and payloads, exception message/stack — shares one pool, with a reserve held so response content has room beside large prompts. Backends that aren't bound by workerd's limits can raise (or tighten) the pool with `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` — e.g. `contentBudgetBytes: 200_000` ships fuller prompts and tool results to a non-workerd observability backend. Payloads stay valid JSON where they are structurally serialized objects/arrays (oldest messages drop first behind a `role: "flue"` sentinel message, and oversized string leaves are cut with a `[flue:truncated, …]` suffix) — an oversized raw string is cut as a string and no longer parses as JSON. There are no side-channel truncation marker attributes; search payloads for `[flue]` instead.

Tool arguments/results use the standard `gen_ai.tool.call.*` attributes for every payload shape, so standards-aware backends can display them: object and array payloads record as JSON strings, string payloads that fit the remaining content budget record byte-for-byte, and other scalars record as their JSON form. The pinned conventions type these attributes `any` and sanction JSON-string form on spans.

## Metrics and Logs

The instrumentation emits these applicable metrics:

- `gen_ai.client.operation.duration`;
- `gen_ai.client.token.usage`;
- `gen_ai.invoke_agent.duration`;
- `gen_ai.execute_tool.duration`.

Metric attributes exclude conversation, submission, dispatch, operation, turn, task, and tool-call IDs. Input token totals include cache-read and cache-creation input tokens.

Logs are optional and require explicit structural Logger injection. Failed inference operations emit `gen_ai.client.operation.exception` at WARN/13. Error type is always recorded; exception messages and throw-site stack traces (`exception.stacktrace`) ride the content gate — included by default, transformed by your `transform`, absent under `content: false`. Traces and metrics work without a Logger.

## Propagation and recovery

Flue validates and persists `traceparent` plus optional `tracestate` at direct-agent admission. Baggage is not persisted. Durable direct-agent execution activates its extracted admission context. `dispatch(...)` does not currently propagate trace context.

A restarted execution cannot keep an in-memory span open. Recovery does not replay provider or tool execution. Replayed stream chunks do not create chat spans or usage metrics, and synthetic interrupted-tool repairs do not create tool spans.

## Current limitation

Pi does not currently expose authoritative raw provider stream-item lifecycle callbacks. Flue therefore does not emit `gen_ai.client.operation.time_to_first_chunk` or `gen_ai.client.operation.time_per_output_chunk`; semantic text/reasoning deltas and recovered chunks are not valid substitutes.

## Breaking migration

Replace `createOpenTelemetryObserver()` with `createOpenTelemetryInstrumentation()`, replace `observe(...)` registration with `instrument(...)`, and replace the per-event `exportContent` callback with the global `content` policy. The old API and custom `flue.turn.*`/`flue.tool.*` content attributes are not emitted in parallel.

## Unsupported operations

Flue does not fabricate GenAI operations for agent creation, planning, embeddings, retrieval, memory CRUD/search, remote agent clients, or evaluations. These remain absent until Flue has genuine corresponding API boundaries.
