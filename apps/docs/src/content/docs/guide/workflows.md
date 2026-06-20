---
title: Workflows
description: Create finite agent-backed operations from inline or reusable Actions.
lastReviewedAt: 2026-06-19
---

Workflows are finite, inspectable operations for background jobs, document transformations, reviews, and CI tasks. Every workflow binds one [Action](/docs/api/action-api/) to one agent definition. Use an [agent](/docs/guide/building-agents/) instead when work should continue across messages.

## Create a workflow

A file in `src/workflows/` defines a discovered workflow. Its filename becomes the workflow name, and its default export must be the value returned by `defineWorkflow()`:

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
  output: v.object({ summary: v.string() }),

  async run({ harness, input, log }) {
    log.info('Summarization requested', { characters: input.text.length });
    const session = await harness.session();
    const response = await session.prompt(input.text);
    return { summary: response.text };
  },
});
```

`agent` is required. It defines the model, tools, skills, subagents, sandbox, and other execution policy for the harness that Flue creates for each run. The agent may be private to the workflow; it does not need to be discovered under `agents/` unless it should also be addressable through agent routes or `dispatch()`.

The inline `input` and `output` fields are optional Valibot schemas. Input must be a top-level object schema. Flue validates input before `run()` and validates and snapshots the returned output before completing the run.

## Action context

An Action receives a deliberately small context:

| Member    | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `harness` | Invocation-scoped access to sessions, the filesystem, and shell operations. |
| `input`   | Parsed input; present only when the Action declares an input schema.        |
| `log`     | Structured logging for the current execution.                               |

Transport requests, environment bindings, and run IDs are not Action context. Validate transport-specific data before admission and pass required application data explicitly through `input`. Agent initialization may use platform bindings through its `AgentCreateContext`.

The workflow runner owns the agent policy, harness, and resources. The Action borrows them for one invocation. Calling an Action as an agent tool creates an isolated child execution scope with its own default and named sessions; it shares the parent configuration, sandbox, and filesystem, cannot reenter the waiting parent session, and is retained and cleaned up with its parent.

## Extract reusable Actions

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

const summarizer = defineAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
}));

export default defineWorkflow({ agent: summarizer, action: summarize });
```

`defineWorkflow()` accepts exactly one of `action` or `run`. Inline Actions are workflow-private and therefore do not need a name or description.

## Expose routes separately

HTTP exposure remains a module concern, separate from workflow execution:

```ts title="src/workflows/summarize.ts"
import type { WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();
```

This exposes `POST /workflows/summarize` and applies the middleware to invocation and run reads. Do not put `route` inside `defineWorkflow()`. A route-free workflow remains available to `flue run` and ambient `invoke()`.

## Invoke workflows

### CLI

Run a discovered workflow locally without exposing HTTP:

```bash
pnpm exec flue run summarize --target node --input '{"text":"Flue workflows complete finite operations."}'
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

`invoke()` admits a real workflow run and returns after admission. The imported value must be the exact default export of a discovered workflow module. It does not run workflow route middleware and does not require an HTTP route.

Use `dispatch(agent, { id, input })` for asynchronous input to a continuing agent instance. It returns a `dispatchId` and does not create workflow run history. Use `invoke(workflow, { input })` for one finite run; it returns a `runId`.

### HTTP and SDK

An HTTP-exposed workflow accepts its input as the JSON request body at `POST /workflows/:name`. The SDK provides the same routed boundary through `client.workflows.invoke(name, { input })`. Add `?wait=result` over HTTP, or `wait: 'result'` in the SDK, to wait for the terminal result.

## Work with the harness

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

## Inspect runs

Every invocation creates a workflow run with a unique `runId`.

| Surface                                           | Use it for                                     |
| ------------------------------------------------- | ---------------------------------------------- |
| `flue logs <runId>`                               | Replay or follow run events from the CLI.      |
| `GET /runs/<runId>`                               | Read the Durable Streams event stream.         |
| `GET /runs/<runId>?meta`                          | Read the persisted `RunRecord`.                |
| `client.runs.get()`, `.events()`, and `.stream()` | Build application tooling around a known run.  |
| `listRuns()` and `getRun()`                       | Build protected server-side inspection routes. |

`RunRecord.input` and the `run_start.input` event contain the admitted workflow input. Inputs, results, logs, and model activity may be sensitive; authorize any published run-inspection surface.

Only workflows create runs. Direct agent prompts and `dispatch()` inputs belong to persistent agent sessions and do not appear in `/runs` or `flue logs`.
