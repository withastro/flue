---
title: Deploy Agents with Docker
description: Package the Flue Node.js build as a portable container image.
lastReviewedAt: 2026-07-21
---

Package the Flue Node.js build as a container image that runs on any platform that takes one. For the underlying build and runtime behavior, see [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

Flue's Node target is a long-running HTTP server, not a function. The container must stay up to hold agent sessions and serve streamed responses; deploy it as a service, not a scale-to-zero invocation.

## Dockerfile

A multi-stage build keeps the runtime image lean: compile the Node target in the first stage, ship only production dependencies and `dist/` in the second.

```dockerfile title="Dockerfile"
# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
```

The build externalizes your application dependencies rather than bundling them, so the runtime stage installs production dependencies (`vite` and `@flue/vite` stay build-only devDependencies and are dropped by `--omit=dev`). Add a `.dockerignore` for `node_modules`, `dist`, `.git`, and `.env` so local artifacts and secrets never enter the image.

The official `node` images ship a non-root `node` user (uid 1000); `USER node` drops superuser privileges in the running container. Node was not designed to run as PID 1 and won't reap children or forward signals cleanly, so run the container with an init — `docker run --init` (shown below) or a baked-in `tini`/`dumb-init` — so `SIGTERM` reaches the server for a graceful shutdown of in-flight streams.

The server binds `PORT` (default `3000`; this image sets `8080`). Match it to whatever your platform expects.

## Build and run

```bash
docker build -t flue-agents .
docker run --init -p 8080:8080 -e ANTHROPIC_API_KEY=sk-... flue-agents
```

## Environment and secrets

The built server reads only the environment supplied when the container starts — it does not load `.env`. Pass your model provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and an optional `MODEL_SPECIFIER` at run time, and inject them through your platform's secret store rather than baking them into the image:

```bash
docker run --init -p 8080:8080 \
  -e MODEL_SPECIFIER=anthropic/claude-sonnet-4-6 \
  -e ANTHROPIC_API_KEY=sk-... \
  flue-agents
```

## Persistence

Without a `db.ts` adapter the server keeps canonical agent conversations, attachments, and accepted submissions in process-local memory, so a restart or redeploy loses them. Add a Postgres-backed [`PersistenceAdapter`](/docs/guide/database/) for replacement recovery. Multiple replicas must still route each agent instance to one live owner; shared storage does not enable active-active same-instance execution:

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

Flue discovers `db.ts` at build time and wires it into the generated server. Provide `DATABASE_URL` as an environment variable like any other secret. See [Postgres](/docs/ecosystem/databases/postgres/) for the full bring-your-own-driver runner.

## Health and streaming

Flue does not generate a health endpoint. If your platform health-checks the container, define the route it expects (commonly `/health`) in your `app.ts`.

Agent conversations use long-lived `GET` reads on the conversation URL (long-poll/SSE). Ensure the platform's request and idle-connection timeouts allow them. Message admission returns `streamUrl`, `offset`, and `submissionId`; clients can reconnect and resume the conversation stream from an offset. See [Streaming Protocol](/docs/reference/streaming-protocol/).

## References

- [Docker — Containerize a Node.js application](https://docs.docker.com/guides/nodejs/containerize/) (official): multi-stage builds, `.dockerignore`, `EXPOSE`/`PORT`.
- [Node.js Docker — Best Practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md) (official): `NODE_ENV=production`, non-root `node` user, `--init`/tini for PID-1 signal handling.
- [Docker run reference — init process](https://docs.docker.com/engine/reference/run/#specify-an-init-process) (official): the `--init` flag.
- [Snyk — 10 best practices to containerize Node.js with Docker](https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/): non-root `USER`, exec-form `CMD`, graceful shutdown.
