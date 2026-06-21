---
title: Workflows
description: Create finite agent-backed operations from inline or reusable Actions.
lastReviewedAt: 2026-06-20
---

Workflows are finite, inspectable operations for background jobs, document transformations, reviews, and CI tasks. Every workflow binds one [Action](/docs/api/action-api/) to one agent definition. Use an [agent](/docs/guide/building-agents/) instead when work should continue across messages.

## Create a workflow

A file in `src/workflows/` defines a discovered workflow. Its filename becomes the workflow name, and its default export must be the value returned by `defineWorkflow()`:

```ts title="src/workflows/summarize.ts"
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

export default defineWorkflow({
  agent: defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' })),
  input: v.object({ text: v.string() }),
  output: v.object({ summary: v.string() }),

  async run({ harness, input }) {
    const session = await harness.session();
    const response = await session.prompt(input.text);
    return { summary: response.text };
  },
});
```

This defines the `summarize` workflow. Each invocation validates the supplied text, asks the model to summarize it, and returns a validated `{ summary }` result. Use this pattern for finite work that should have its own run, result, and event history. See the [Workflow API](/docs/api/workflow-api/) for the complete definition contract.

## Reuse an Action

Use `defineAction()` when the same finite behavior should back multiple workflows or be callable by a model through an agent's `actions` list:

```ts title="src/actions/summarize.ts"
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';

export const summarize = defineAction({
  name: 'summarize_document',
  description: 'Summarize a document clearly and concisely.',
  input: v.object({ text: v.string() }),
  output: v.object({ summary: v.string() }),

  async run({ harness, input }) {
    const response = await (await harness.session()).prompt(input.text);
    return { summary: response.text };
  },
});
```

Bind the extracted Action without repeating its schemas or handler:

```ts title="src/workflows/summarize.ts"
import { defineAgent, defineWorkflow } from '@flue/runtime';
import { summarize } from '../actions/summarize.ts';

export default defineWorkflow({
  agent: defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' })),
  action: summarize,
});
```

Start inline when behavior belongs to one workflow. Extract an Action when another workflow or a model should call the same operation. See [`defineAction()`](/docs/api/action-api/#defineaction) and [`defineWorkflow()`](/docs/api/workflow-api/#defineworkflow) for their complete options.

## Invoke a workflow

### CLI

Run a discovered workflow locally without exposing HTTP:

```bash
pnpm exec flue run summarize --input '{"text":"Flue workflows complete finite operations."}'
```

`flue run` validates the JSON supplied to `--input`, reports run events, and prints the successful result as JSON. Its temporary child process does not publish run-inspection routes and its history disappears when the command exits.

### Application code

Use ambient `invoke()` from application-owned routes, channels, schedules, or other code executing inside a Flue-built server:

```ts
import { invoke } from '@flue/runtime';
import summarize from './workflows/summarize.ts';

const { runId } = await invoke(summarize, {
  input: { text: 'Summarize this document.' },
});
```

`invoke()` admits a real workflow run and returns its `runId` without waiting for completion. Import the exact default export of a discovered workflow module. Use `dispatch()` instead when input should continue one persistent Agent conversation.

## Expose a workflow over HTTP

Workflow HTTP access is private by default. Two independent module exports control it:

| Export  | Exposes                                                |
| ------- | ------------------------------------------------------ |
| `route` | Invocation at `POST /workflows/<name>`.                |
| `runs`  | Run records and event streams beneath `/runs/<runId>`. |

Use the same authentication policy for both when callers should be able to invoke and inspect a workflow:

```ts title="src/workflows/summarize.ts"
import type { WorkflowRouteHandler, WorkflowRunsHandler } from '@flue/runtime';
import { requireUser } from '../auth.ts';

export const route: WorkflowRouteHandler = requireUser;
export const runs: WorkflowRunsHandler = requireUser;
```

Each handler is ordinary Hono middleware. Calling `next()` allows the request; returning a response denies it. Export only `route` when callers may start work but must not inspect runs, or only `runs` when runs created by schedules or application code should be inspectable.

With both exports, an SDK caller can invoke and then inspect the run:

```ts
const { runId } = await client.workflows.invoke('summarize', {
  input: { text: 'Summarize this document.' },
});

const record = await client.runs.get(runId);
const events = await client.runs.events(runId);
```

Invocation returns `{ runId }`, or `{ runId, result }` with `wait: 'result'`. The `runs` export also controls `client.runs.stream()`, raw `GET` and `HEAD` requests to `/runs/<runId>`, and `flue logs`. Without the corresponding export, HTTP clients receive `404`. Run data may contain sensitive inputs, results, and model activity, so do not treat a run ID as a credential.

These exports do not affect `flue run`, schedules, ambient `invoke()`, or server-side `listRuns()` and `getRun()`. See the [Workflow API HTTP exports](/docs/api/workflow-api/#http-exports) for the complete contract.

## Use the workflow harness

The harness is ready when the Action starts. Use its default session for related operations and its filesystem or shell for workflow-controlled setup:

```ts
async run({ harness, input }) {
  await harness.fs.writeFile('document.md', input.document);
  const session = await harness.session();
  await session.prompt('Review document.md and write findings to review.md.');
  return { review: await harness.fs.readFile('review.md') };
}
```

A session can also run skills, delegate tasks, and produce schema-backed structured results. See [Agent API](/docs/api/agent-api/), [Skills](/docs/guide/skills/), [Subagents](/docs/guide/subagents/), and [Sandboxes](/docs/guide/sandboxes/).
