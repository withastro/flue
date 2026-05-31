---
title: Routing API
description: Compose Flue routes in an authored application entrypoint.
lastReviewedAt: 2026-05-30
---

Import application composition APIs from `@flue/runtime/app`.

## `app.ts`

`app.ts` is an optional authored application entrypoint. Without it, Flue generates an application that mounts `flue()` at `/`. When `app.ts` exists, its default export owns the request pipeline and must mount `flue()` explicitly to publish Flue routes.

```ts title="src/app.ts"
import { flue } from '@flue/runtime/app';
import { Hono } from 'hono';

const app = new Hono();
app.route('/', flue());
export default app;
```

See [Routing](/docs/guide/routing/) for middleware, custom routes, prefixes, and application-owned dispatch.

#### `Fetchable`

```ts
interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

Structural contract for the default export of an authored `app.ts` entry. Any object exposing a compatible `fetch()` method satisfies it, including a `new Hono()` instance.

On Cloudflare, `env` contains bindings and `ctx` is the `ExecutionContext`. On Node, `env` contains Hono's Node adapter bindings for the incoming and outgoing messages, and `ctx` is `undefined`.

## `flue()`

```ts
function flue(): Hono;
```

Creates a mountable Hono sub-app for Flue's public HTTP and WebSocket API. Routes are relative to the application-chosen mount prefix.

| Route                     | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `GET /openapi.json`       | Return the public OpenAPI document.                                       |
| `POST /agents/:name/:id`  | Prompt an HTTP-exposed agent instance.                                    |
| `GET /agents/:name/:id`   | Upgrade to a WebSocket connection for a WebSocket-exposed agent instance. |
| `POST /workflows/:name`   | Start an HTTP-exposed workflow run.                                       |
| `GET /workflows/:name`    | Upgrade to a WebSocket invocation for a WebSocket-exposed workflow.       |
| `GET /runs/:runId`        | Retrieve a workflow run record.                                           |
| `GET /runs/:runId/events` | Retrieve persisted workflow run events.                                   |
| `GET /runs/:runId/stream` | Stream workflow run events over SSE.                                      |

Agent and workflow routes are available only when the corresponding module opts into that transport. Run routes inspect workflow runs only and may expose payloads, results, errors, and events. Applications publishing them should authorize access to the selected run. Direct agent prompts and dispatched agent inputs are not runs.

## `admin()`

```ts
function admin(): Hono;
```

Creates a mountable Hono sub-app for read-only deployment inspection. Mount it explicitly beneath an application-chosen prefix and protect that mount with application-owned authorization.

```ts title="src/app.ts"
import { admin, flue } from '@flue/runtime/app';
import { Hono, type MiddlewareHandler } from 'hono';
import { authenticateOperator } from './auth.ts';

const requireOperator: MiddlewareHandler = async (c, next) => {
  if (!(await authenticateOperator(c.req.raw))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};

const app = new Hono();
app.route('/', flue());
app.use('/admin/*', requireOperator);
app.route('/admin', admin());
export default app;
```

| Route               | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `GET /openapi.json` | Return the administrative OpenAPI document.     |
| `GET /agents`       | List built agents and their transport metadata. |
| `GET /runs`         | List workflow run summaries.                    |
| `GET /runs/:runId`  | Retrieve a workflow run record.                 |
