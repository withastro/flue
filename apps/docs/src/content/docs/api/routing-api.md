---
title: Routing API
description: Compose Flue routes in an authored application entrypoint.
lastReviewedAt: 2026-06-02
---

Import application composition APIs from `@flue/runtime/routing`.

## `app.ts`

`app.ts` is an optional authored application entrypoint. Without it, Flue generates an application that mounts `flue()` at `/`. When `app.ts` exists, its default export owns the request pipeline and must mount `flue()` explicitly to publish Flue routes.

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
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

Creates a mountable Hono sub-app for Flue's public HTTP API. Routes are relative to the application-chosen mount prefix.

| Route                      | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `GET /openapi.json`        | Return the public OpenAPI document.                                  |
| `POST /agents/:name/:id`   | Start a prompt on an HTTP-exposed agent instance; returns `202` with stream coordinates. |
| `GET /agents/:name/:id`    | Stream agent events via the Durable Streams protocol.                |
| `HEAD /agents/:name/:id`   | Return agent stream metadata (tail offset, closed status).           |
| `POST /workflows/:name`    | Start an HTTP-exposed workflow run.                                  |
| `GET /runs/:runId`         | Stream workflow-run events via the Durable Streams protocol.         |
| `HEAD /runs/:runId`        | Return run stream metadata (tail offset, closed status).             |

Agent and workflow invocation routes are available only when the corresponding module exports a `route` handler. Run routes inspect workflow runs only and are available beneath `flue()` after a run is admitted, regardless of whether that workflow exposes HTTP invocation. They may expose payloads, results, errors, and events. Applications publishing them should authorize access to the selected run. Direct agent prompts and dispatched agent inputs are not runs.

`POST /agents/:name/:id?wait=result` waits for the terminal result and returns `200 { result, streamUrl, offset }`. Without `?wait=result`, the same route returns `202 { streamUrl, offset }` after admission. `POST /workflows/:name?wait=result` similarly waits for the workflow result; without it, the route returns `202 { runId }`.

## `admin()`

```ts
function admin(): Hono;
```

Creates a mountable Hono sub-app for read-only deployment inspection. Mount it explicitly beneath an application-chosen prefix and protect that mount with application-owned authorization.

```ts title="src/app.ts"
import { admin, flue } from '@flue/runtime/routing';
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

| Route               | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `GET /openapi.json` | Return the administrative OpenAPI document.                            |
| `GET /agents`       | List all built agents and their transport metadata without pagination. |
| `GET /runs`         | List workflow run summaries.                                           |
| `GET /runs/:runId`  | Retrieve a workflow run record.                                        |
