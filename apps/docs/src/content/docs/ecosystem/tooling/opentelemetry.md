---
title: OpenTelemetry
description: Export Flue agents, model calls, and tools with OpenTelemetry GenAI semantics.
package:
  name: '@flue/opentelemetry'
  href: https://www.npmjs.com/package/@flue/opentelemetry
lastReviewedAt: 2026-07-21
---

`@flue/opentelemetry` projects Flue's live runtime observations into standard OpenTelemetry GenAI spans and metrics. It does not configure an SDK, exporter, sampling, credentials, or deployment-specific flushing.

The package implements the Development GenAI conventions pinned at commit `4c8addb53718b544134be47e256237026fe88875`. Its Flue-to-GenAI projection revision is `5` and its Flue extension revision is `4`; the vocabulary, projection, and revision constants live in `@flue/runtime/telemetry` and are shared verbatim with the [native Cloudflare tracing adapter](/docs/guide/cloudflare-target/#createcloudflaretracing), so a payload written for one backend reads identically on the other. Updating any revision requires an explicit compatibility review.

## Configure

Install the adapter and OpenTelemetry API alongside an SDK and exporter compatible with your deployment target:

```sh
pnpm add @flue/opentelemetry @opentelemetry/api
```

Configure the SDK first, then register one instrumentation instance:

```ts title="src/app.ts (abridged)"
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

const instrumentation = createOpenTelemetryInstrumentation();
const disposeInstrumentation = instrument(instrumentation);
```

Pass configured tracer, meter, or structural Logger instances when the application owns them. Generated Node applications automatically dispose registrations created while evaluating `app.ts` after admissions and active work drain. Call `await disposeInstrumentation()` yourself only when registering outside that lifecycle, then flush or shut down the application-owned SDK/exporter separately.

## Trace model

- A prompt or skill operation becomes `invoke_agent <agent>`.
- A delegated task becomes one task-owned `invoke_agent <agent>`.
- Provider inference becomes a `chat <requested-model>` client span.
- A GenAI tool execution becomes `execute_tool <name>`.
- A caller shell execution becomes `flue.operation shell`.
- A context compaction becomes `flue.compaction` with child chat spans.

Provider chat spans cover provider inference only. The projection reads canonical model telemetry directly: semantic `request.providerName` becomes `gen_ai.provider.name`, while `request.providerId` remains the Flue registration identity. Local tools are sibling spans under the agent invocation and correlate with model output through `gen_ai.tool.call.id`.

`gen_ai.conversation.id` identifies one persisted Flue session. It is not a submission, dispatch, operation, trace, session name, or provider-affinity key. Flue correlation fields remain under documented `flue.*` attributes when no exact standard field exists.

## Protect content

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

A detached converted value passes through `transform` once per content type; returning `undefined` omits that content, and a throwing transform emits a `[flue]` failure sentinel instead of the unredacted value. `scope` carries the content type, event type, execution identity, and `traceId`/`spanId`. For byte budgets, slice inside the transform or use the exported `truncateContent(content, { maxBytes })`. After the transform, a fixed 56 KiB per-attribute safety budget is enforced **in-band**: payloads stay valid JSON, oldest messages drop first behind a `role: "flue"` sentinel message, and oversized strings are cut with a `[flue:truncated, …]` suffix — there are no side-channel truncation marker attributes; search payloads for `[flue]` instead.

Object-shaped tool arguments/results use standard `gen_ai.tool.call.*` attributes; other shapes use `flue.tool.call.arguments` or `flue.tool.call.result` under the same policy.

## Metrics and Logs

The instrumentation emits client-operation, token-usage, agent-invocation, and tool-duration histograms. Metric dimensions exclude execution IDs; review your application-controlled agent, tool, provider, and model names for appropriate cardinality. Input token totals include cache-read and cache-creation input tokens.

Logs require explicit Logger injection. Failed inference operations emit the standard `gen_ai.client.operation.exception` event at WARN/13. Error type is always recorded; exception messages and throw-site stack traces (`exception.stacktrace`) ride the content gate — included by default, transformed by your `transform`, absent under `content: false`. Logger absence does not affect traces or metrics.

## Propagation and recovery

Flue validates and persists `traceparent` and optional `tracestate` at direct-agent admission. Baggage is not persisted. Durable direct-agent processing activates its extracted admission context, and execution interceptors activate owning spans around agent, model-stream, tool, and task work. `dispatch(...)` does not currently propagate trace context.

Recovery does not replay provider or tool execution. Stored stream chunks create no chat spans or usage observations, and synthetic interrupted-tool repairs create no `execute_tool` spans.

## Streaming limitation

Pi does not expose authoritative raw provider stream-item timing. Flue therefore omits time-to-first-chunk and time-per-output-chunk metrics instead of deriving inaccurate values from semantic text/reasoning deltas or recovered chunks.

## Unsupported operations

Flue does not emit invented spans for agent creation, planning, embeddings, retrieval, memory operations, remote agent clients, or evaluations. These operations remain absent until Flue exposes a genuine corresponding boundary.

## Verify

Use an in-memory OpenTelemetry exporter in tests to verify hierarchy, names, kinds, status, attributes, metrics, and your content policy (including that `content: false` or your transform actually removes what you expect). Hosted backend rendering is backend-specific; standards-correct OTel output is the portable contract.
