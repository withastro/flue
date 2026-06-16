# HTTP Routing

Use this when composing Flue routes with application-owned HTTP behavior.

## `app.ts`

Without `app.ts`, Flue generates an application mounted at `/`. With `app.ts`, export a Hono app and mount Flue explicitly:

```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', flue());

export default app;
```

Use `app.ts` for authentication, route prefixes, custom webhooks, health checks, and middleware.

## Published Flue Route Families

| Export | Route family |
| --- | --- |
| Agent `route` | `POST /agents/:name/:id` and `GET /agents/:name/:id` |
| Workflow `route` | `POST /workflows/:name` |
| Channel `channel` | `/channels/:name/<provider-suffix>` |
| Run routes | `GET /runs/:runId` and `GET /runs/:runId?meta` |

Mounting `flue()` does not expose every agent or workflow. Agent and workflow modules opt in with their own `route` exports. Run routes are registered beneath the mount path and must be protected by middleware.

## Prefixing

```ts
app.route('/api', flue());
```

This moves all Flue routes beneath `/api`, including agents, workflows, runs, and channels. SDK `baseUrl` must include the prefix.

Discovered channel filenames and provider suffixes are fixed below the mount. Use an application-owned Hono route outside `channels/` when one provider needs complete custom path control.

## Authorization Checklist

- Authenticate broad route families with Hono middleware.
- Authorize selected agent instance IDs in agent route middleware.
- Protect `/runs/*`; run IDs can disclose sensitive work.
- If run existence must stay hidden, return the same `404` shape for unauthorized and unknown runs.
- For custom provider routes, verify the provider request before dispatching to an agent.

