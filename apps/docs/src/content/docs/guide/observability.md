---
title: Observability
description: Observe agent activity through the runtime event stream — model turns, tool calls, logs, and token usage — and export it to your observability stack.
lastReviewedAt: 2026-07-21
---

Flue emits everything its agents do — model turns, tool calls, structured logs, compactions, and settlements — as typed **runtime events** your application can observe in process. This surface is separate from the per-conversation message stream a chat UI reads, which belongs to [Routing](/docs/guide/routing/) and the [Flue Agent SDK](/docs/sdk/overview/). This guide covers the two surfaces and when to use each, subscribing with `observe()`, what the event stream contains, token usage and provider diagnostics on model turns, tool activity and logs, exporting telemetry to Sentry, Braintrust, and OpenTelemetry, and how agent activity surfaces in Cloudflare's platform observability.

## Two event surfaces

Flue exposes agent activity on two distinct surfaces:

- The **conversation stream** is the product surface: one conversation's durable, render-ready messages, data parts, and settlements, consumed over HTTP with [`createFlueClient(...)`](/docs/sdk/create-flue-client/) `observe()` / `history()`. [Routing](/docs/guide/routing/#reading-the-conversation) covers it.
- The **runtime event stream** is the operational surface: live activity across every agent in the process — model requests, tool executions, logs, token counts, failures — consumed in process with [`observe()`](/docs/reference/events/#observe) from `@flue/runtime`. That stream is this guide's subject.

The two APIs share a name but not a shape: the SDK client's `observe()` maintains one conversation's materialized message state, while the runtime's `observe()` delivers raw activity events. Telemetry, metering, and error reporting belong on the runtime stream. The surfaces share correlation identifiers — a conversation message's `submissionId` matches the runtime events its submission produced.

## Subscribing with `observe()`

`observe()` from `@flue/runtime` registers a global subscriber for all agent activity in the current process. Register it once at startup, at module top level in `app.ts` (or a module `app.ts` imports):

```ts title="src/app.ts"
import { observe } from '@flue/runtime';

observe((event) => {
  if (event.type === 'submission_settled' && event.outcome === 'failed') {
    console.error(
      `[${event.agentName}] submission ${event.submissionId} failed:`,
      event.error?.message,
    );
  }
});
```

The subscriber receives every event from every agent — direct prompts, dispatched work, subagent tasks, and harness activity alike. `observe()` returns an unsubscribe function, but telemetry subscribers typically register once and never remove themselves; the return value exists for tests and dynamic wiring.

Three rules for subscribers:

- **Stay cheap.** Subscribers run synchronously on the event emission path. Branch on `event.type`, return immediately for activity you don't consume, and queue substantial async work instead of blocking emission.
- **Treat events as read-only.** Each delivery is a detached, frozen observation; a subscriber can never alter what other subscribers or the runtime see.
- **Failures are contained.** A throwing subscriber is logged and skipped — it never halts the agent or other subscribers. Returned promises are observed for rejection but not awaited.

The subscription is **isolate-scoped and live-only**: it sees activity emitted in the current process from the moment it registers, with no durable replay and no cross-process aggregation. On Node.js one process hosts all agents, so one registration sees everything. On [Cloudflare](/docs/guide/cloudflare-target/), each agent conversation runs in its own Durable Object isolate — a subscriber registered from `app.ts` runs in each isolate and sees that isolate's activity only. One placement caveat, shared with `setProvider()`: [`flue run`](/docs/cli/run/) loads only the agent module, never `app.ts` — register in the agent module when a subscriber must also run under the CLI.

## What the stream contains

Every event carries the event-format version (`v: 3`), a per-context `eventIndex`, a `timestamp`, and the correlation fields that apply to it, including `agentName`, `conversationId`, `instanceId`, `submissionId`, `operationId`, `turnId`, and `taskId`. The event families:

| Events                                                | Activity                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `agent_start`, `agent_end`, `idle`                    | Agent loop lifecycle.                                                                            |
| `submission_settled`                                  | A durable submission reached `completed`, `failed`, or `aborted` — the reliable terminal signal. |
| `operation_start`, `operation`                        | Prompt, skill, task, shell, and compact operation boundaries, with duration and rolled-up usage. |
| `turn_start`, `turn_request`, `turn`, `turn_messages` | Model turns (see [below](#token-usage)).                                                         |
| `message_*`, `text_delta`, `thinking_*`               | Live message and reasoning progress.                                                             |
| `tool_start`, `tool`                                  | Tool execution, correlated by `toolCallId`.                                                      |
| `task_start`, `task`                                  | Subagent task delegation, with result, error state, and duration.                                |
| `compaction_start`, `compaction`                      | Context compaction, with message counts and usage.                                               |
| `log`                                                 | Structured logs written by your tools and hooks (see [below](#tool-activity-and-logs)).          |

Streaming deltas are live progress signals, not authoritative message state; the assistant `message_end` event carries the completed message. Nested errors do not necessarily fail the work that contains them — an agent can recover from a failed turn or tool call — so alert on `submission_settled` outcomes and read nested `isError` events as diagnostic context.

Two properties of the live stream go beyond what is durably recorded:

- **Live observations carry extra detail.** `observe()` delivers each event as a `FlueObservation` — the event plus live-only fields such as normalized tool arguments, effective results, and classified `errorInfo` including the throw-site stack. These exporter-oriented fields are never persisted or replayed.
- **`turn_request` is in-process only.** It contains the full model-visible request — provider identity, settings, system prompt, messages, and tools — and is delivered to `observe()` subscribers but never persisted or served over HTTP.

The [Events Reference](/docs/reference/events/) documents every event's fields and which payloads are stable contract.

## Token usage

Each completed model call emits a `turn` event whose `request` summarizes what was sent (provider, requested model, API, settings) and whose `response` carries the outcome — output, finish reason, and `usage`:

| `usage` field             | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `input`, `output`         | Tokens sent to and generated by the model.                                 |
| `cacheRead`, `cacheWrite` | Prompt-cache tokens read and written.                                      |
| `totalTokens`             | Total across all components.                                               |
| `cost`                    | Estimated cost from the model catalog's rates, per component plus `total`. |

Per-agent token metering is a single observer:

```ts title="src/app.ts"
import { observe } from '@flue/runtime';
import { metrics } from './shared/metrics.ts';

observe((event) => {
  if (event.type !== 'turn' || !event.response.usage) return;
  const { usage } = event.response;
  metrics.increment('llm.tokens', usage.totalTokens, {
    agent: event.agentName,
    model: event.request.requestedModel,
    purpose: event.purpose, // 'agent' | 'compaction' | 'compaction_prefix'
  });
  metrics.increment('llm.cost', usage.cost.total, { agent: event.agentName });
});
```

Usage also rolls up at coarser boundaries: `operation` and `compaction` events carry aggregate usage for the work they bound. When summing usage across events, sum one level only — `turn` values are the leaves, and the roll-ups already include them. Duration values at different levels overlap the same way and should not be added together. Inside the agent, `useResponseFinish()` receives the whole response's aggregate usage — the right place to stamp token counts onto response metadata for your client; see [Event hooks](/docs/guide/agent-hooks/#event-hooks).

## Provider diagnostics

A `turn` event's `response` is normalized — `finishReason` and `error` use Flue's vocabulary regardless of provider. Alongside them, the response carries allowlisted raw provider metadata when the provider attaches it:

- `providerFinishReason` — the provider's exact finish value before normalization (for example, Workers AI's `tool_calls` behind the normalized `toolUse`).
- `gatewayLogId` — the response's own Cloudflare AI Gateway log id (`cf-aig-log-id`), for correlating a specific turn with its entry in the gateway dashboard.

Both are telemetry only — they never affect execution or replay — and are present only when the provider records them. The [Workers AI provider](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) attaches both today. A diagnostic observer for failed turns reads them directly from the event:

```ts title="src/app.ts"
import { observe } from '@flue/runtime';

observe((event) => {
  if (event.type !== 'turn' || !event.isError) return;
  console.error('model turn failed', {
    provider: event.request.providerName,
    model: event.request.requestedModel,
    finishReason: event.response.finishReason,
    providerFinishReason: event.response.providerFinishReason,
    gatewayLogId: event.response.gatewayLogId,
    error: event.response.error?.message,
  });
});
```

`request.providerId` is the registration key from the model specifier; `request.providerName` is the semantic provider identity, which differs when a gateway or custom registration fronts the model.

## Tool activity and logs

Tool execution emits `tool_start` and `tool` events carrying the tool name, `toolCallId`, duration, error state, and result — for both model-driven calls and programmatic shell activity. The live observation adds the normalized arguments and effective result.

For progress inside a long-running tool, the tool's `run` context provides a logger (see [Tools](/docs/guide/tools/#how-a-tool-call-works)); lifecycle hook contexts like `useAgentStart` carry the same `log` interface. Each call emits a `log` event with a level, a message, and your attributes — tool logs additionally stamped with `tool` and `toolCallId`, hook logs with the hook that wrote them. The model never sees log lines; they exist for your application:

```ts title="src/tools/sync-crm.ts (excerpt)"
async run({ data, log }) {
  log.info('sync started', { records: data.ids.length });
  const failed = await crm.sync(data.ids);
  if (failed.length > 0) log.error('sync incomplete', { failed: failed.length });
  return { synced: data.ids.length - failed.length };
}
```

```ts title="src/app.ts"
import { observe } from '@flue/runtime';
import { logger } from './shared/logger.ts';

observe((event) => {
  if (event.type !== 'log') return;
  logger.log(event.level, event.message, {
    ...event.attributes,
    conversation: event.conversationId,
  });
});
```

Log lines are runtime events, not conversation content: they never appear in the messages a client renders, and they reach only in-process subscribers — forward them to your logging backend from an observer, or through one of the integrations below.

## Choose an observability provider

For production telemetry, Flue ships integrations with three ecosystems rather than a bundled dashboard:

- [Sentry](/docs/ecosystem/tooling/sentry/) — terminal failures as issues, every log in Sentry Logs, and optional AI traces with content off by default. Add with `flue add tooling sentry`.
- [Braintrust](/docs/ecosystem/tooling/braintrust/) — LLM tracing: operations as traces with model, tool, task, and compaction spans plus usage. Add with `flue add tooling braintrust`.
- [OpenTelemetry](/docs/ecosystem/tooling/opentelemetry/) — standards-based GenAI spans, metrics, and logs for any OTel-compatible backend. Add `@flue/opentelemetry` to your OTel SDK setup.

The Sentry and Braintrust [blueprints](/docs/cli/add/) generate a source-root module that `app.ts` imports — an event bridge like the ones above, plus provider initialization. Span-producing integrations register through `instrument(...)`, which pairs an observer with an execution interceptor so spans wrap live agent, model, tool, and task execution:

```ts title="src/app.ts (abridged)"
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

instrument(createOpenTelemetryInstrumentation());
```

Choose Sentry when you want failures, logs, and traces in an existing application monitor, Braintrust when you want content-bearing LLM traces for inspection and evaluation, and OpenTelemetry when your organization standardizes on an OTel backend. They compose — an error reporter and a tracer can subscribe side by side. On Cloudflare, each integration exports per isolate and final flushes are best-effort; each tooling page documents its target-specific behavior.

## Cloudflare

On the [Cloudflare target](/docs/guide/cloudflare-target/), agent work is also visible to the platform's own observability products, with no Flue-side wiring. Each agent response runs as one unit of platform work — admission answers immediately, then the response executes start-to-settlement as a single invocation the platform can see and measure. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) attribute tool and hook logs to the response that wrote them, and [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/) capture one trace per response — model calls and other subrequests appear as spans inside it. Both are enabled in `wrangler.jsonc`; see [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/#observability) for configuration and the [Cloudflare target guide](/docs/guide/cloudflare-target/#durable-agent-execution) for the execution model behind the attribution.

To add agent-shaped spans to those traces, install the native tracing adapter once in `app.ts`:

```ts title="src/app.ts"
import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';

instrument(createCloudflareTracing());
```

Each response's trace then carries an `invoke_agent` span wrapping the run, a `chat` span per model turn with token usage, and an `execute_tool` span per tool call, using the same OpenTelemetry GenAI naming Cloudflare's own agent tracing emits — Flue agents read natively in the Traces dashboard. The spans carry the conversation by default: input and output messages, system instructions, and tool definitions, arguments, and results, so you can read what the agent actually said and did straight from the trace. Raw error messages and stack traces are the exception — they never ship on this backend, and failures record only a low-cardinality `error.type`. Pass `content: false` for content-free spans, or a `transform` to redact or drop content in code; see [`createCloudflareTracing()`](/docs/guide/cloudflare-target/#createcloudflaretracing) for the attribute surface, the truncation contract, and behavior details.

The platform view and the runtime event stream are complementary, not redundant. Workers Observability shows operational shape — invocations, durations, outcomes, subrequests, and with the adapter, agent identity, usage, and conversation content; the runtime events remain the full-fidelity stream: settlement outcomes, error details, everything a trace attribute can't hold. Use the platform products for fleet health, latency, and reading conversations, and the runtime stream (or an integration above) for anything that needs the complete record.

## Protect sensitive content

Runtime events can contain prompts, system instructions, reasoning, tool arguments and results, and error details — and **both trace adapters capture conversation content by default**. Installing an instrumentation with `instrument(...)` is the consent: nothing is emitted by merely deploying, but once that line exists, prompts and tool payloads flow to the receiving backend. Every adapter takes the same two controls: `content: false` turns capture off entirely, and `content: { transform }` is the policy hook — redact, drop by `scope.contentType`, or tighten the byte budget with `truncateContent`.

Two protections are unconditional: `turn_request` events never leave the process, and image content blocks never carry raw bytes (their `data` is replaced with the `IMAGE_DATA_OMITTED` sentinel). Beyond those, each exporter has its own posture: the Cloudflare adapter never emits raw error messages or stacks, the OpenTelemetry adapter passes exception messages and stack traces through the same content gate, the Sentry integration keeps model and tool content out of traces unless its record flags opt in, and Braintrust is content-bearing with a masking hook. Review the retention and access controls of whatever receives your traces, and make the data-handling decision explicitly.

## Next steps

- [Events Reference](/docs/reference/events/) — the full event vocabulary, envelope fields, and the `observe()` contract.
- [Routing](/docs/guide/routing/) and the [Agent SDK](/docs/sdk/overview/) — the conversation stream your UI consumes.
- [Agent Hooks](/docs/guide/agent-hooks/#event-hooks) — read usage and stamp response metadata from inside the agent.
- [Sentry](/docs/ecosystem/tooling/sentry/), [Braintrust](/docs/ecosystem/tooling/braintrust/), and [OpenTelemetry](/docs/ecosystem/tooling/opentelemetry/) — per-integration setup and content policies.
- [Evals](/docs/guide/evals/) — turn observed behavior into scored regression checks.
