# OpenTelemetry for Flue

`@flue/opentelemetry` converts Flue's public `observe(...)` event stream into OpenTelemetry spans. It does not instrument Flue internals or configure an exporter.

## Usage

Configure your OpenTelemetry SDK and exporter in your application, then register the observer in `.flue/app.ts`:

```ts
import { createOpenTelemetryObserver } from '@flue/opentelemetry';
import { observe } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

observe(createOpenTelemetryObserver());

const app = new Hono();
app.route('/', flue());
export default app;
```

Pass a tracer when the application already owns a configured tracer instance:

```ts
observe(createOpenTelemetryObserver({ tracer }));
```

Workflow and standalone operation spans start as independent roots by default. To attach them to an application-owned span, explicitly resolve an OpenTelemetry parent context:

```ts
import { context } from '@opentelemetry/api';

observe(
  createOpenTelemetryObserver({
    resolveRootContext: () => context.active(),
  }),
);
```

The resolver runs only when a Flue span has no tracked Flue parent. Return `undefined` to preserve root behavior selectively. Dispatched input does not carry trace context automatically; resolve any dispatched parent from application-owned correlation state.

## Span mapping

| Flue events                            | Span                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `run_start` / `run_resume` / `run_end` | Workflow root span or recovered run-handling segment; `run_resume` adds `flue.workflow.recovery_handling` |
| `operation_start` / `operation`        | Operation span; root for direct or dispatched processing                                                  |
| `turn_request` / `turn`                | Model-generation span                                                                                     |
| `tool_start` / `tool_call`             | Tool span, including `harness.shell(...)`                                                                 |
| `task_start` / `task`                  | Delegated-task span                                                                                       |
| `compaction_start` / `compaction`      | Compaction span                                                                                           |
| `log`                                  | Span event                                                                                                |

A recovered workflow handling segment represents terminal processing after interruption, not resumed workflow code. If the interrupted workflow span still exists in the same isolate, the recovery segment links to it and closes any still-open descendants as interrupted. After an isolate reset, correlate segments through `flue.run_id` and event indexes when available; Flue does not persist trace context automatically.

## Identity and accounting

Spans include `flue.event.start_index` and `flue.event.end_index` when the corresponding Flue lifecycle events carry indexes. Log span events include `flue.event.index`. For successfully persisted workflow events, combine an index with `flue.run_id` to correlate trace activity with workflow history and Durable Streams offsets. The adapter receives live events, so the presence of an index does not prove persistence succeeded. `flue.dispatch_id` remains the delivery identity for dispatched work.

Model-turn leaf spans export `gen_ai.usage.*`. Compaction spans and operation spans may also export `flue.compaction.usage.*` and `flue.operation.usage.*` roll-ups for inspection. Do not sum roll-ups together with their nested model-turn leaf usage. Likewise, `flue.duration_ms` values are elapsed durations for nested boundaries and can overlap. A recovered workflow handling span reports the run-level total as `flue.workflow.total_duration_ms`, not the recovery segment's elapsed time.

## Sensitive content

By default, spans contain identifiers, durations, model/provider attributes, token/cost metadata, log levels, and generic failure messages only. They do not contain detailed terminal errors, workflow payloads/results, model input/output, tool arguments/results, task prompts/results, or log content.

To export content, provide an application-owned sanitizer. It receives a shallow copy of each content-bearing Flue event. Return a sanitized event to export its supported content values, or return `undefined` to omit content from that event:

```ts
observe(
  createOpenTelemetryObserver({
    sanitize(event) {
      if (event.type !== 'log') return undefined;

      return {
        ...event,
        message: redactLogMessage(event.message),
        attributes: redactLogAttributes(event.attributes),
      };
    },
  }),
);
```

The adapter retains the original event for span lifecycle correlation. If you modify nested values, clone the paths you change rather than mutating the original nested objects.

For local debugging with intentionally unsanitized data, pass `sanitize: (event) => event`. This can export workflow payloads/results, detailed errors, model-visible messages including system prompts, reasoning-bearing content and image bytes, log content, tool arguments/results, task prompts/results, and task working directories. Review exporter retention and access requirements before enabling it. Metadata such as ids and session names may also be sensitive if your application embeds customer data in them.
