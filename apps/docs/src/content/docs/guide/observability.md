---
title: Observability
description: Inspect workflow runs, monitor agent activity, and export telemetry from your application.
lastReviewedAt: 2026-06-15
---

Observability helps you understand whether Flue work completed, failed, became slow, or used more model resources than expected. Inspect workflow run history for bounded jobs, and use `observe(...)` to monitor workflows and continuing agents across your application.

## Inspect workflow runs

Each workflow invocation has a `runId`. Its run history records the completed result or error and the observable activity produced while the workflow executes.

Use the Action context's `log` methods to record application-specific facts that runtime activity alone cannot explain. For example, a summarization workflow can report the size of the accepted document and the usage of the completed operation:

```ts title="src/workflows/summarize.ts"
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

const summarizer = defineAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Summarize the supplied document clearly and concisely.',
}));

export default defineWorkflow({
  agent: summarizer,
  input: v.object({ text: v.string() }),

  async run({ harness, log, input }) {
    log.info('Summarization requested', { characters: input.text.length });
    const response = await (await harness.session()).prompt(input.text);

    log.info('Summarization completed', {
      tokens: response.usage.totalTokens,
      cost: response.usage.cost.total,
    });

    return { summary: response.text };
  },
});
```

`log.info(...)`, `log.warn(...)`, and `log.error(...)` accept structured attributes. Use attributes for values that you may later search, aggregate, or forward to a monitoring system. See [`ActionContext`](/docs/api/action-api/#actioncontext) for the Action logging contract.

When a workflow invoked through a running application reports its `runId`, use that identifier to inspect the workflow run from the command line:

```bash
pnpm exec flue logs <runId> --server http://localhost:3583
```

`flue logs` applies only to workflows. A direct prompt to an agent, or input accepted through `dispatch(...)`, is work in a continuing agent session rather than a workflow run. Dispatched inputs use `dispatchId` as their delivery identity.

A workflow's `startedAt` timestamp is captured before durable admission finishes. Live observers receive `run_start` after admission setup, immediately before workflow code begins. This distinction matters when admission itself takes time: `startedAt` describes the admitted invocation's full lifetime, while `run_start` marks the beginning of live workflow execution.

## Observe application activity

Register `observe(...)` in your application entrypoint when you need telemetry across workflows and continuing agents. The observer receives activity handled by that running application context, including operations triggered by asynchronously dispatched input.

```ts title="src/app.ts"
import { observe } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

observe((event) => {
  if (event.type === 'run_end' && event.isError) {
    console.error('Workflow failed', event.runId, event.error);
  }

  if (event.type === 'operation' && event.durationMs > 5_000) {
    console.warn('Slow operation', event.operationKind, event.durationMs);
  }

  if (event.type === 'log' && event.level === 'error') {
    console.error(event.message, event.attributes);
  }
});

const app = new Hono();
app.route('/', flue());

export default app;
```

An operation is the useful finite boundary for agent activity, such as prompting a session, running a skill, or delegating work. Direct and dispatched agent input can therefore be monitored without treating a continuing agent as a series of workflow runs.

When an operation is slow or unexpectedly expensive, its nested activity can provide the explanation. One prompt operation may include multiple model turns or tool calls. Model turns expose latency, token usage, and cost; tool activity shows where the agent spent time or encountered an error.

Callbacks registered with `observe(...)` are invoked while Flue emits activity and receive every emitted event object directly. Treat events as read-only, branch on `event.type`, and return immediately for activity you do not consume. Keep callbacks lightweight; returned promises are observed for rejection but are not awaited. In a distributed deployment, each running application context observes only the activity it handles; use an external backend to aggregate telemetry across processes or isolates.

Streaming deltas are best-effort live progress; use `message_end` as the authoritative completed assistant message. A subscriber attached after generation starts may miss earlier partial output until that event arrives. Internal interrupted-turn recovery uses separate durable state and is unaffected.

## Choose an observability provider

| Provider                                                | Choose it when                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [OpenTelemetry](/docs/ecosystem/tooling/opentelemetry/) | You need vendor-neutral traces or already operate an OpenTelemetry-compatible backend.                              |
| [Braintrust](/docs/ecosystem/tooling/braintrust/)       | You want content-bearing agent traces, model usage, costs, and evaluation-oriented debugging.                       |
| [Sentry](/docs/ecosystem/tooling/sentry/)               | You primarily want actionable workflow failures and explicit error logs without exporting model content by default. |

You can also consume `observe(...)` directly when these integrations do not match your telemetry or data-handling requirements.

## Export telemetry safely

Runtime events can contain workflow inputs, prompts, model messages, logs, tool values, errors, and application-owned metadata. Flue replaces image data in recognized content blocks with an omission sentinel before events are observed or persisted, but arbitrary inputs, log attributes, tool details, and results still require an application-owned sanitization policy.

Start with outcome-oriented signals: failed workflows, explicit application error logs, slow operations, and completed model usage. A model turn or tool call may fail before an agent recovers, so treating every nested error as an incident can create noisy alerts. When aggregating usage, sum model-turn leaf values rather than operation or compaction roll-ups; nested duration values can overlap and should not be summed.

Restrict subscriptions to required event types and review the retention, access, and redaction controls of any external backend before exporting content. The provider guides above describe each integration's default export policy and runtime-specific behavior.

## Next steps

- [Events reference](/docs/api/events-reference/) — inspect the complete observable event contract.
- [Workflows](/docs/guide/workflows/) — create finite operations whose run history can be inspected.
- [Agents](/docs/guide/building-agents/) — create continuing agent instances and deliver direct or dispatched input.
- [Routing](/docs/guide/routing/) — add the application entrypoint where telemetry observers are registered.
