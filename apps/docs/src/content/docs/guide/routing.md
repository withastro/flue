---
title: Routing
description: Compose Flue with application routes, middleware, and custom HTTP ingress.
lastReviewedAt: 2026-05-29
---

`src/app.ts` is an optional entrypoint for providing your own HTTP application in a Flue project. Add this file when your application needs authentication, health checks, webhooks, route prefixes, or other routes alongside the agents and workflows exposed by Flue.

It is an ordinary [Hono](https://hono.dev/) application, so you can compose Flue routes with your own routes and middleware.

## `app.ts`

Without `src/app.ts`, Flue generates an application that mounts its public routes at `/`. When you add `src/app.ts`, export a Hono application and mount `flue()` explicitly:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono, type MiddlewareHandler } from 'hono';
import { authenticate } from './auth.ts';

const requireUser: MiddlewareHandler = async (c, next) => {
  const user = await authenticate(c.req.raw);

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/agents/*', requireUser);
app.use('/workflows/*', requireUser);
app.use('/runs/*', requireUser);
app.route('/', flue());

export default app;
```

In this application, `/health` is an application-owned route, while `flue()` serves exposed agents, exposed workflows, and workflow run routes. The middleware protects those Flue route families before requests reach their handlers.

Use broader middleware for requirements shared by a group of routes, such as requiring an authenticated user. When access depends on a specific selected resource, apply that check as well: for example, an agent route should verify that the caller may access the agent instance named by its `id`, and an application that publishes workflow run reads should authorize access to the selected run.

Because your authored application imports `Hono`, include `hono` in your application dependencies. See [Project Layout](/docs/guide/project-layout/) for alternative source directories supported by existing projects.

## Add custom routes

A custom application can serve any route your service needs. It can also accept an external event, verify and normalize it, and deliver it to an agent without exposing a direct prompt route for that event source:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import supportAssistant from './agents/support-assistant.ts';
import { parseVerifiedSupportComment } from './support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await parseVerifiedSupportComment(c.req.raw);
  const receipt = await dispatch(supportAssistant, {
    id: event.ticketId,
    input: {
      type: 'support.comment.created',
      commentId: event.commentId,
      text: event.text,
    },
  });

  return c.json(receipt, 202);
});

app.route('/', flue());

export default app;
```

Here, the webhook route belongs to your application: it determines which requests are valid and which agent instance receives the accepted input. `dispatch(...)` delivers that input asynchronously to the continuing agent session. See [Agents](/docs/guide/building-agents/) for agent interaction patterns and [Chat](/docs/guide/chat/) for conversational platform integrations.

## Customized routing

For most applications, mount Flue at the root with `app.route('/', flue())`. You can instead mount it beneath a prefix when Flue is one part of a larger API:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/api', flue());

export default app;
```

With this mount, an exposed `support-assistant` agent is available beneath `/api/agents/support-assistant/:id`, and an exposed `summarize-ticket` workflow is available beneath `/api/workflows/summarize-ticket`. Workflow run routes and Flue's OpenAPI output are mounted beneath the same prefix. SDK consumers should include the mount pathname in `baseUrl`, such as `createFlueClient({ baseUrl: 'https://example.com/api' })`.

Apply middleware to the mounted paths your application publishes, such as `/api/agents/*`, `/api/workflows/*`, and `/api/runs/*` in this example.

## Exposing agents and workflows

Mounting `flue()` does not make every discovered agent or workflow directly invocable. Each module opts into its public transports:

| Module export    | Available through the mounted Flue application                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Agent `route`    | HTTP prompts at `POST /agents/:name/:id` and event streaming at `GET /agents/:name/:id` beneath the mount path. |
| Workflow `route` | HTTP invocation at `POST /workflows/:name` beneath the mount path.                                               |

Run event streaming at `GET /runs/:runId` is not gated by any module export: it is registered unconditionally beneath the mount path and serves events for any admitted workflow run, however it was invoked. Unknown run IDs return `404`.

An agent used only through application-owned `dispatch(...)` calls does not need a public transport export.

See [Agents](/docs/guide/building-agents/) for creating and exposing continuing agent instances, and [Workflows](/docs/guide/workflows/) for exposing finite operations and inspecting their runs.

## Next steps

- [Agents](/docs/guide/building-agents/) — create continuing agents and deliver direct or dispatched input.
- [Workflows](/docs/guide/workflows/) — create finite operations and inspect workflow runs.
- [Chat](/docs/guide/chat/) — compose conversational platform ingress with agent sessions.
- [Develop & Build](/docs/guide/develop-and-build/) — run the application locally, create build output, and continue to deployment.
- [Observability](/docs/guide/observability/) — observe workflow runs and agent activity.
