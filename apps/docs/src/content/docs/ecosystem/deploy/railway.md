---
title: Deploy Agents on Railway
description: Run the Flue Node server as a long-running Railway service.
---

Flue's Node target is a long-running HTTP server, not a serverless function, so it deploys to Railway as a standard service that stays up between requests. This guide covers the Railway-specific setup; the build itself is the same `node` target described in [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) — `npx flue build --target node` produces `dist/server.mjs`, which you start with `node dist/server.mjs`.

Railway owns the platform — building the repo, injecting `PORT`, running the start command, provisioning Postgres. Flue owns the server it starts. The two meet at the build command, the start command, and a handful of environment variables.

## Build and start

Railway builds a connected repo with [Railpack](https://railpack.com), which auto-detects Node projects with zero configuration. Set the build and start commands so Railpack compiles the Flue Node target and launches the generated server:

- **Build command** — `npm ci && npx flue build --target node`
- **Start command** — `node dist/server.mjs`

The build externalizes your dependencies rather than bundling them, so `node_modules` must be present at runtime. `npm ci` installs them; keep `@flue/cli` available to the build command. The built server reads only the environment present when it starts — it does not load `.env` — so configuration lives in Railway variables, not a committed file.

To build from a container instead, drop the Dockerfile from [Deploy Agents with Docker](/docs/ecosystem/deploy/docker/) at the repo root. Railway detects a root `Dockerfile` (capital `D`) and builds with it in place of Railpack; point at a non-standard path with the `RAILWAY_DOCKERFILE_PATH` variable.

## Config as code

Pin the build and deploy settings in a `railway.json` (or `railway.toml`) at the repo root so they travel with the code rather than living only in the dashboard:

```json title="railway.json"
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "npm ci && npx flue build --target node"
  },
  "deploy": {
    "startCommand": "node dist/server.mjs",
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

Set `build.builder` to `DOCKERFILE` (with `build.dockerfilePath` if non-standard) to use the Docker path instead. `deploy.healthcheckPath` only works if your application exposes that route — see [Health and streaming](#health-and-streaming) below.

## Environment variables

Set variables on the service's **Variables** tab. Flue needs the API key for your model provider, plus an optional model specifier:

| Variable                               | Purpose                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Authenticates calls to your model provider.                                                             |
| `MODEL_SPECIFIER`                      | Optional default model, e.g. `anthropic/claude-sonnet-4-6`, if your app reads one from the environment. |

Use the variable name your provider expects, and **seal** the provider key so its value is supplied to builds and deploys but never readable back through the dashboard or API (sealing is one-way — a sealed variable cannot be un-sealed). Railway injects `PORT` automatically and the server binds it on `0.0.0.0` (defaulting to `3000` only when unset), so leave `PORT` unset and let Railway choose it — binding to `0.0.0.0` rather than `localhost` is what lets Railway's proxy reach the service. Do not set the reserved `FLUE_MODE` or `FLUE_CLI_*` variables in production.

## Persistence

The Node target keeps agent sessions and accepted submissions in memory by default. That state is lost on every restart and redeploy, and it is not shared across replicas — so an in-memory service that scales past one instance will route follow-up requests to processes that never saw the original session.

For durable, shared session history, add a Railway Postgres service (**+ New > Database > PostgreSQL**) to the same project. The database exposes a `DATABASE_URL`; wire it into your Flue service with a reference variable rather than copying the value:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Then install the adapter and read that variable in `db.ts`:

```bash
npm install @flue/postgres
```

```typescript title=".flue/db.ts"
import { postgres } from '@flue/postgres';

export default postgres(process.env.DATABASE_URL!);
```

Flue discovers `db.ts` at build time and wires it into the generated server — schema creation, session snapshots, and durable submission state are handled by the adapter. See [Database](/docs/guide/database/) for the adapter contract and alternatives.

## Health and streaming

Flue does not generate a `/health` route. If you set `deploy.healthcheckPath`, define the matching route in `app.ts` — otherwise Railway's check never passes and the deploy is held back. Without a health check, Railway considers the deploy ready once the process binds `PORT`.

Streamed runs are served over a long-lived `GET /runs/:runId` connection (long-poll/SSE). These requests stay open for the life of the run, so favor reading the returned stream coordinates over a single blocking `?wait=result` request for agents that run long tool chains. Railway's edge proxy keeps connections open for active streaming, but treat any single attached request as bounded — move genuinely long work to a scheduled run or a separate worker.

## Going further

- **Scheduled workflows.** Model periodic tasks (nightly summaries, cache refreshes) as a separate service with a **Cron Schedule** whose start command is `npx flue run <workflow> --target node`. Each fire builds, runs the workflow once, and exits — close any Postgres connections so the process terminates cleanly. Railway enforces a minimum interval of five minutes, evaluates schedules in UTC, and skips a fire if the previous run is still active.
- **Queue-backed workers.** For continuous, queue-driven delivery, run a second always-on service that makes attached agent requests and waits for results, or have application code call `dispatch(...)` for asynchronous delivery identified by `dispatchId`. A worker service has no public port; it just runs `node dist/server.mjs` (or a custom entry) and processes work.

## References

- [Config as code](https://docs.railway.com/reference/config-as-code) — official `railway.json`/`railway.toml` field reference (`build.builder`, `buildCommand`, `startCommand`, `healthcheckPath`, `restartPolicyType`).
- [Variables](https://docs.railway.com/guides/variables) — official guide to variables, sealed secrets, and the `${{Service.VAR}}` reference syntax.
- [Cron jobs](https://docs.railway.com/reference/cron-jobs) — official scheduling rules: UTC, five-minute minimum, skip-if-active.
- [Deploy an Express app](https://docs.railway.com/guides/express) — Railway's worked example of deploying a standard Node server.
