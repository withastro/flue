---
title: Scheduling
description: Run Flue work on a schedule by using platform-owned schedulers.
lastReviewedAt: 2026-06-18
---

Flue does not include a native scheduler. Scheduled work belongs to the platform that runs your application: cron, systemd, CI, queue infrastructure, managed cron products, or Cloudflare Worker cron triggers.

Use the scheduler to start ordinary Flue work through the same entrypoints you use for non-scheduled work:

- Invoke a workflow when the scheduled job is finite and should produce a workflow run.
- Dispatch input to a persistent agent instance when the scheduled job should continue an agent session.
- Call public HTTP routes, a small script using `@flue/sdk`, or `flue run` from the scheduler.

Avoid running production schedules with `setInterval` inside your Node process. It is not durable: it stops when the process exits, misses work during deploys or restarts, and can run more than once when your service has multiple replicas.

## Node.js

Node has no Flue lifecycle hook equivalent to Cloudflare's `scheduled()` handler. Use an external scheduler and make it call the running Flue app or run the Flue CLI.

Good scheduler owners include:

- host cron or systemd timers on a VM;
- GitHub Actions scheduled workflows, GitLab CI schedules, or another CI scheduler;
- Render Cron Jobs or another managed cron product;
- queue workers, job runners, or your existing orchestration system.

### Invoke a workflow over HTTP

For most scheduled jobs, expose a workflow route and let the scheduler call `POST /workflows/<name>`.

```ts title="src/workflows/digest.ts"
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const writer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Write concise operational digests.',
}));

export async function run({ init, payload }: FlueContext<{ source: string }>) {
  const harness = await init(writer);
  const session = await harness.session();
  const response = await session.prompt(`Prepare the scheduled digest for ${payload.source}.`);

  return { digest: response.text };
}
```

Build and run the Node server:

```bash
npx flue build --target node
node dist/server.mjs
```

Then point your scheduler at the workflow route:

```bash
curl -fsS -X POST 'https://flue.example.com/workflows/digest' \
  -H 'content-type: application/json' \
  -d '{"source":"cron"}'
```

The default response is `202 { "runId": "...", "streamUrl": "...", "offset": "..." }`. Use the returned run ID with `flue logs`, `/runs/<runId>`, or `client.runs` when you need to inspect events. Add `?wait=result` only when the scheduler should wait for the workflow result in the same HTTP request.

### Run the CLI from a scheduler

When the scheduler runs in an environment that has the project checkout, dependencies, and secrets, it can execute a workflow directly:

```bash
pnpm exec flue run digest --target node --payload '{"source":"cron"}'
```

This is useful for cron on a single host or CI schedules. `flue run` starts a temporary Node target process for the invocation and exits after the workflow completes; it is not a replacement for a long-running service when you need persistent run inspection routes.

### Use the SDK from a small script

If your scheduling platform runs JavaScript, keep the schedule in that platform and use `@flue/sdk` to call your deployed Flue app:

```ts title="scripts/run-digest.ts"
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: process.env.FLUE_URL!,
  token: process.env.FLUE_TOKEN,
});

const run = await client.workflows.invoke('digest', {
  payload: { source: 'scheduler' },
});

console.log(run.runId);
```

The script can run from GitHub Actions, a queue worker, a managed cron job, or any other scheduler that can reach your Flue app.

### Dispatch to an agent from a route

When scheduled work should enter a continuing agent session instead of a workflow run, expose an application route that authenticates the scheduler and calls `dispatch(...)`:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import digest from './agents/digest.ts';

const app = new Hono();

app.post('/scheduled/digest', async (c) => {
  const receipt = await dispatch(digest, {
    id: 'global',
    input: { type: 'daily.digest', scheduledAt: new Date().toISOString() },
  });

  return c.json(receipt, 202);
});

app.route('/', flue());

export default app;
```

Dispatched input does not create a workflow run. Use it when the scheduled event is part of a persistent agent instance's session history.

## Cloudflare

On Cloudflare, use a Worker cron trigger for deployment-wide scheduled work. Add a source-root `cloudflare.ts` file and export a default object with a `scheduled(...)` handler. In the standard `src/` layout, that file is `src/cloudflare.ts`.

```ts title="src/agents/digest.ts"
import { createAgent } from '@flue/runtime';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Process scheduled digest work for the whole deployment.',
}));
```

```ts title="src/cloudflare.ts"
import { dispatch } from '@flue/runtime';

export default {
  async scheduled(controller) {
    await dispatch({
      agent: 'digest',
      id: 'global',
      input: {
        type: 'daily.digest',
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      },
    });
  },
} satisfies ExportedHandler;
```

Configure the cron trigger in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": {
    "crons": ["0 12 * * *"],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["FlueRegistry", "FlueDigestAgent"],
    },
  ],
}
```

Flue merges its generated Worker exports and Durable Object bindings with your authored `cloudflare.ts` handlers. The cron trigger invokes the Worker-level `scheduled(...)` handler, and `dispatch(...)` durably admits input to the `digest` agent instance named `global`.

Test the handler locally with the Cloudflare scheduled-handler endpoint:

```bash
npx flue dev --target cloudflare
curl 'http://localhost:3583/cdn-cgi/handler/scheduled?format=json'
```

Cloudflare returns a scheduled-handler result such as `{"outcome":"ok","noRetry":false}` when the handler completes successfully.

See Cloudflare's [Scheduled Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) documentation for handler parameters, multiple cron triggers, and local testing details.

## Choosing the entrypoint

Use a workflow when you want a scheduled run with a `runId`, terminal result, and workflow event inspection. Use `dispatch(...)` when the schedule should deliver an event to a continuing agent instance and no workflow run should be created.
