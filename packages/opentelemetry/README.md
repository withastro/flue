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

## Sensitive content

By default, spans contain identifiers, terminal error messages, durations, model/provider attributes, and token/cost metadata only. They do not contain workflow payloads/results, model input/output, tool arguments/results, task prompts/results, or log content.

To explicitly send those values to the configured exporter:

```ts
observe(createOpenTelemetryObserver({ captureContent: true }));
```

Review exported data retention and redaction requirements before enabling content capture.
