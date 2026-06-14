---
title: Workflows
description: Create finite agent-backed operations, run them, and inspect their outcomes.
lastReviewedAt: 2026-05-29
---

Workflows are useful when your application needs an agent to complete a single unit of work without an ongoing conversation, such as a background job, document transformation, code review, or CI task. This guide covers creating a workflow, controlling its execution in code, and inspecting its result. If you need an agent that continues accepting messages over time, see [Agents](/docs/guide/building-agents/).

## Creating a new workflow

In a Flue project, a workflow is a file in `src/workflows/` that exports a `run(...)` function. The filename gives the workflow its name: `src/workflows/summarize.ts` defines the `summarize` workflow.

```ts title="src/workflows/summarize.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const summarizer = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Summarize the supplied document clearly and concisely.',
}));

export async function run({ init, payload }: FlueContext<{ text: string }>) {
  const harness = await init(summarizer);
  const session = await harness.session();
  const response = await session.prompt(payload.text);

  return { summary: response.text };
}
```

In this example:

- **The filename:** This gives the workflow its name: `summarize`.
- `createAgent(...)`: This defines the agent used to perform the work.
- `run(...)`: This is the unit of work Flue runs for each invocation. It receives the workflow's [`FlueContext`](/docs/api/agent-api/#fluecontext), which also carries `id`, `env`, `req`, and `log`.
- `init(summarizer)`: This initializes the created agent for this workflow invocation and returns its harness.
- `harness.session()`: This opens the default session used for the operation.
- **The return value:** This becomes the completed workflow result.

A workflow can contain ordinary TypeScript logic before, between, or after agent operations: load application data, branch on input, log progress, or transform a response before returning it. Configure the agent's model, instructions, tools, skills, and sandbox through `createAgent(...)`, as you would for an addressable agent.

Prefer `init(agent)` and `session.prompt(...)` for model-backed work inside a workflow, even when the workflow only makes one model call. Calling a provider binding or SDK directly bypasses Flue's model resolution, tools, skills, sandbox configuration, operation events, and response handling.

See [Project Layout](/docs/guide/project-layout/) for supported source layouts, [Models & Providers](/docs/guide/models/) for model configuration, and [Agents](/docs/guide/building-agents/) for agent configuration concepts.

## Running a workflow

Each time a workflow is invoked, Flue creates a **workflow run** with a unique `runId`. The run captures its completed result or error and can include events from the agent operations performed inside `run(...)`.

### Local execution

Use `flue run` to execute a discovered workflow locally or from CI. The workflow does not need to be exposed over HTTP:

```bash
pnpm exec flue run summarize --target node --payload '{"text":"Flue workflows complete finite agent-backed operations."}'
```

`flue run` reports the run identity and events, and prints the successful workflow result as JSON. Local execution currently builds and runs the Node target in a temporary child process. Its printed run ID is useful for correlating inline output, but the child does not publish run-inspection routes and its history disappears when the command exits.

### HTTP

Export `route` when callers should invoke the workflow over HTTP:

```ts title="src/workflows/summarize.ts"
import type { WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();
```

An exposed `summarize` workflow accepts requests at `POST /workflows/summarize`. The route middleware is also the boundary where your application can authenticate or reject an incoming request before starting a run.

By default, `POST /workflows/summarize` returns `202 { runId, streamUrl, offset }` after admission. Add `?wait=result` to wait for the completed result in the same request. For HTTP response modes, authentication, and custom application mounts, see [Routing](/docs/guide/routing/).

Application-owned routes, Worker handlers, and other workflows should use the same admission boundary when they want a real workflow run. Do not import a workflow module and call `run(...)` directly from `app.ts`, `cloudflare.ts`, an email handler, or a scheduler; that bypasses Flue's admission path, durable run storage, events, route middleware, and run inspection APIs. Instead, call the mounted workflow route with an authenticated `Request`, or extract shared pure application logic into a separate module that both the workflow and the caller can use.

## Working with the harness

`init(agent)` returns a harness: the initialized environment your workflow uses for that agent. Through the harness, application code can prepare the agent's workspace and open sessions where the agent performs work.

### Files and commands

A workflow can provide files for an agent to work on and collect the generated artifact after it finishes:

```ts title="src/workflows/review-document.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  cwd: '/workspace',
}));

export async function run({ init, payload }: FlueContext<{ document: string }>) {
  const harness = await init(reviewer);
  await harness.fs.writeFile('document.md', payload.document);

  const session = await harness.session();
  await session.prompt('Review document.md and write your findings to review.md.');

  return { review: await harness.fs.readFile('review.md') };
}
```

`harness.fs` lets your application stage inputs and retrieve output files in the agent's workspace. Use `harness.shell(...)` when application code needs to prepare or inspect that workspace with a command before the agent works in it. These are workflow-controlled setup steps; they do not add messages to the session conversation.

The workspace available to a harness is determined by the agent's sandbox configuration. See [Sandboxes](/docs/guide/sandboxes/) for filesystem and execution environments.

### Sessions

A session is where the agent's work accumulates context. Use the default session when a later instruction should continue from earlier work:

```ts title="src/workflows/investigate-incident.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const investigator = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init, payload }: FlueContext<{ incident: string }>) {
  const harness = await init(investigator);
  const session = await harness.session();

  await session.prompt(`Analyze this incident:\n\n${payload.incident}`);
  const response = await session.prompt('Now recommend the next three actions.');

  return { recommendation: response.text };
}
```

In addition to prompting, a session can run an available skill, delegate a task to a configured subagent, or execute a command that later agent work should know about. See [Skills](/docs/guide/skills/) for reusable procedures and [Subagents](/docs/guide/subagents/) for delegated work.

### Structured results

When a workflow needs dependable application data rather than prose, provide a schema for the result. The agent must return data that satisfies the schema before the workflow receives it:

```ts title="src/workflows/classify-ticket.ts"
import { createAgent, type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

const triage = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export async function run({ init, payload }: FlueContext<{ ticket: string }>) {
  const harness = await init(triage);
  const session = await harness.session();
  const response = await session.prompt(payload.ticket, {
    result: v.object({
      priority: v.picklist(['low', 'medium', 'high']),
      summary: v.string(),
    }),
  });

  return response.data;
}
```

Use structured results when later application code depends on specific fields, instead of parsing a textual answer. See the [Agent API](/docs/api/agent-api/) for result errors, operation options, and response types.

## Managing workflow runs

When a workflow is invoked through a running application, its `runId` lets you inspect the run independently of the HTTP request that started it. This is useful for background work, live progress, debugging, and operational tooling.

| Surface                                           | Use it for                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flue logs <runId>`                               | Inspect or follow events for a workflow run from the command line.                                                                                                 |
| `GET /runs/<runId>`                               | Stream run events via the Durable Streams protocol.                                                                                                                |
| `GET /runs/<runId>?meta`                          | Read the workflow-run record as plain JSON.                                                                                                                        |
| `client.runs.get()`, `.events()`, and `.stream()` | Build application tooling around a known workflow run.                                                                                                             |
| `listRuns()` from `@flue/runtime`                 | List workflow runs from your own protected server-side endpoints. See [compose your own admin endpoints](/docs/api/routing-api/#compose-your-own-admin-endpoints). |

Run listing can reveal workflow payloads, results, model activity, and application logs. Only publish a listing surface behind an authorization boundary appropriate for that data.

Only workflows create workflow runs. Direct HTTP prompts to an agent instance, and asynchronous input delivered through `dispatch(...)`, are operations in persistent agent sessions; they are not queried through workflow run history or `flue logs`.

For event contents, structured logging, filtering, and telemetry export, see [Observability](/docs/guide/observability/). For securing workflow invocation and run endpoints, see [Routing](/docs/guide/routing/).

## Next steps

- [Agents](/docs/guide/building-agents/) — create and configure continuing agent instances.
- [Agent API](/docs/api/agent-api/) — look up session operations, structured results, and workspace methods.
- [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), and [Sandboxes](/docs/guide/sandboxes/) — configure what the agent in a workflow can do and where it works.
- [Routing](/docs/guide/routing/) — expose workflows over HTTP and protect their endpoints.
- [Observability](/docs/guide/observability/) — inspect run events and connect execution to monitoring and tracing tools.
