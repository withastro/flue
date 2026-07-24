---
title: Deploy Agents on Fly.io
description: Deploy Flue agents to Fly.io as a long-running Docker app on Fly Machines.
lastReviewedAt: 2026-07-21
---

A Flue server is a long-running HTTP service, not a serverless function, so deploy it to Fly Machines that stay up rather than scaling to zero between requests. `fly launch` builds the [Flue Docker image](/docs/ecosystem/deploy/docker/) and runs it on Machines, which suit a stateful, always-on server well.

## Launch from the Dockerfile

With a [Flue Dockerfile](/docs/ecosystem/deploy/docker/) at the project root, `fly launch` detects it, registers the build, and generates a `fly.toml`. The image is built and deployed by `fly deploy` — `fly launch` only records how to build it.

```bash
fly launch
fly deploy
```

The Dockerfile builds `dist/server.mjs` (`npx vite build`, with the `flue()` plugin in `vite.config.ts`) and starts it with `node dist/server.mjs`. The server binds `PORT` (default 3000), so set `ENV PORT` in the image — or whatever port the image exposes — and make `internal_port` in `fly.toml` match it. The build externalizes dependencies, so `node_modules` must be present in the image at runtime.

## fly.toml essentials

`fly launch` writes a starter `fly.toml`. The fields that matter for a Flue server:

```toml
app = "my-flue-agents"
primary_region = "iad"

[http_service]
  internal_port = 8080         # must match the image's PORT / EXPOSE
  force_https = true
  auto_stop_machines = "off"   # keep the server up; see below
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"           # must be defined in app.ts; Flue adds none
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

`auto_stop_machines` and `auto_start_machines` are meant to move together. Leaving auto-stop on (`"stop"` or `"suspend"`) with `min_machines_running = 0` is scale-to-zero — appropriate for stateless web apps, but wrong for a Flue server: a stopped Machine severs any in-flight streaming connection and discards in-memory session state. Keep at least one Machine running with `auto_stop_machines = "off"` (or `min_machines_running = 1`), and put durable state in Postgres.

## Secrets

Provider keys and model configuration are secrets, exposed to the app as environment variables on every Machine. `fly secrets set` restarts the Machines to apply them; the built server reads only this start-time environment, so a `.env` file is not used in production.

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set MODEL_SPECIFIER=anthropic/claude-sonnet-4-6
```

Use the env var your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. `MODEL_SPECIFIER` is optional and only read if your app consults it.

## Persistence

On Node.js, canonical agent conversations, attachments, and accepted submissions live in memory by default — fine for a single Machine, but lost on restart. Back Flue with Postgres for replacement recovery. Multiple Machines must route each agent instance to one live owner; shared storage alone does not make same-instance active-active execution safe.

[Fly Managed Postgres](https://fly.io/docs/mpg/) (MPG) is the recommended option; the older unmanaged Fly Postgres (`fly postgres`) still exists, but Fly no longer provides support or guidance for it. `fly mpg create` prompts for a name, region, and plan (or pass `--name` / `--region` / `--plan`); `fly mpg attach` sets `DATABASE_URL` as a secret on the app — the pooled (PgBouncer) connection URL — and restarts it:

```bash
fly mpg create
fly mpg attach <cluster-id> -a my-flue-agents
```

Install the adapter and read `DATABASE_URL` in `db.ts`:

```bash
npm install @flue/postgres
```

```typescript title="src/db.ts (abridged)"
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    /* one checked-out client per transaction; see the Postgres guide */
  },
  close: () => pool.end(),
});
```

Flue discovers `db.ts` at build time and wires it into the generated server. The adapter handles schema creation, canonical conversation streams, immutable attachments, and durable submission state. See [Database](/docs/guide/database/) for adapter details, [Postgres](/docs/ecosystem/databases/postgres/) for the bring-your-own-driver runner, and [Data Persistence API](/docs/reference/data-persistence-api/) for the contract.

## Health and streaming

Flue does not generate a `/health` route — define one in `app.ts` for the `[[http_service.checks]]` path above, or drop the check. Fly's HTTP checks expect a 2xx and do not follow redirects, so with `force_https = true` either run the check over `https` or add `X-Forwarded-Proto = "https"` to its headers.

Agent conversations use long-lived `GET` reads on the conversation URL (long-poll/SSE). Keep at least one Machine running so auto-stop does not cut these connections. For long-running work, retain the admission's `streamUrl` and `offset` and resume the conversation stream instead of holding one blocking request. See the [Streaming Protocol](/docs/reference/streaming-protocol/).

## Going further

- **Regions and scaling.** `fly scale count` adds Machines and `fly scale vm` resizes them. Multi-Machine deployments need shared Postgres for replacement recovery, plus routing that keeps each agent instance on one live Machine and prevents overlapping owners.
- **Scheduled agents.** Use Fly [scheduled Machines](https://fly.io/docs/machines/) to call the deployed application's authenticated agent endpoint — a `POST` to the agent's conversation URL with a `kind: 'signal'` message. Calling the deployed application avoids building and starting another local runtime for every fire. See [Schedules](/docs/guide/schedules/).

## References

- [fly.toml configuration reference](https://fly.io/docs/reference/configuration/) — `[http_service]`, `[[http_service.checks]]`, `[[vm]]` fields and accepted values
- [Deploy an app](https://fly.io/docs/launch/deploy/) — the `fly launch` / `fly deploy` flow and Dockerfile detection
- [Managed Postgres: create and connect](https://fly.io/docs/mpg/create-and-connect/) — `fly mpg create` / `fly mpg attach` and the `DATABASE_URL` secret
- [Deploying Node.js apps to Fly.io](https://sevic.dev/nodejs-deployment-flyio/) — a community walkthrough of the same Node/Docker deploy path
