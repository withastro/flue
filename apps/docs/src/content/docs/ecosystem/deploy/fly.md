---
title: Deploy Agents on Fly.io
description: Deploy Flue agents to Fly.io as a long-running Docker app on Fly Machines.
---

A Flue server is a long-running HTTP service, not a serverless function, so deploy it to Fly Machines that stay up rather than scaling to zero between requests. `fly launch` builds the [Flue Docker image](/docs/ecosystem/deploy/docker/) and runs it on Machines, which suit a stateful, always-on server well.

## Launch from the Dockerfile

With a [Flue Dockerfile](/docs/ecosystem/deploy/docker/) at the project root, `fly launch` detects it, registers the build, and generates a `fly.toml`. The image is built and deployed by `fly deploy` — `fly launch` only records how to build it.

```bash
fly launch
fly deploy
```

The Dockerfile builds `dist/server.mjs` (`npx flue build --target node`) and starts it with `node dist/server.mjs`. The server binds `PORT` (default 3000), so set `ENV PORT` in the image — or whatever port the image exposes — and make `internal_port` in `fly.toml` match it. The build externalizes dependencies, so `node_modules` must be present in the image at runtime.

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

On Node.js, agent sessions live in memory by default — fine for a single Machine, but lost on restart and not shared across Machines. Once you run more than one Machine, or need state to survive a deploy, back Flue with Postgres.

[Fly Managed Postgres](https://fly.io/docs/mpg/) (MPG) is the recommended option; the older unmanaged Fly Postgres (`fly postgres`) still exists, but Fly no longer provides support or guidance for it. `fly mpg create` prompts for a name, region, and plan (or pass `--name` / `--region` / `--plan`); `fly mpg attach` sets `DATABASE_URL` as a secret on the app — the pooled (PgBouncer) connection URL — and restarts it:

```bash
fly mpg create
fly mpg attach <cluster-id> -a my-flue-agents
```

Install the adapter and read `DATABASE_URL` in `db.ts`:

```bash
npm install @flue/postgres
```

```typescript title=".flue/db.ts"
import { postgres } from '@flue/postgres';

export default postgres(process.env.DATABASE_URL!);
```

Flue discovers `db.ts` at build time and wires it into the generated server. The adapter handles schema creation, session snapshots, and durable submission state. See [Database](/docs/guide/database/) for adapter details and [Data Persistence API](/docs/api/data-persistence-api/) for the contract.

## Health and streaming

Flue does not generate a `/health` route — define one in `app.ts` for the `[[http_service.checks]]` path above, or drop the check. Fly's HTTP checks expect a 2xx and do not follow redirects, so with `force_https = true` either run the check over `https` or add `X-Forwarded-Proto = "https"` to its headers.

Streamed responses use a long-lived `GET /runs/:runId` (long-poll/SSE). Keep at least one Machine running so these connections are not cut by auto-stop, and give the agent's work generous timeouts; for prompts that run long tool chains, return the run's stream coordinates and read from `/runs/:runId` instead of holding a single blocking request.

## Going further

- **Regions and scaling.** `fly scale count` adds Machines and `fly scale vm` resizes them; run more than one Machine across regions for availability. Multi-Machine deployments require shared Postgres for session state — in-memory state is per-Machine.
- **Scheduled workflows.** Model periodic jobs (nightly summaries, cache refreshes) as Fly [scheduled Machines](https://fly.io/docs/machines/) that run `npx flue run <workflow> --target node` once and exit, rather than as inbound agent traffic against the always-on server. See [Scheduling](/docs/guide/scheduling/) for other Flue entrypoint options.

## References

- [fly.toml configuration reference](https://fly.io/docs/reference/configuration/) — `[http_service]`, `[[http_service.checks]]`, `[[vm]]` fields and accepted values
- [Deploy an app](https://fly.io/docs/launch/deploy/) — the `fly launch` / `fly deploy` flow and Dockerfile detection
- [Managed Postgres: create and connect](https://fly.io/docs/mpg/create-and-connect/) — `fly mpg create` / `fly mpg attach` and the `DATABASE_URL` secret
- [Deploying Node.js apps to Fly.io](https://sevic.dev/nodejs-deployment-flyio/) — a community walkthrough of the same Node/Docker deploy path
