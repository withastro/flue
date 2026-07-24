---
title: Deploy Agents on SST
description: Deploy Flue agents to AWS with SST as a long-running Fargate container service.
lastReviewedAt: 2026-07-21
---

[SST](https://sst.dev) is a TypeScript infrastructure-as-code framework for AWS. You describe your infrastructure as components in a single `sst.config.ts` file and deploy it with `sst deploy`. This guide deploys a Flue agent as a persistent container service, not as a Lambda function: Flue's streaming responses use long-lived conversation `GET` connections, and its default coordinator keeps state in memory, so it must run as an always-on process. SST's `sst.aws.Service` component runs exactly that — a container on AWS Fargate behind a load balancer.

This guide builds on the [Docker](/docs/ecosystem/deploy/docker/) guide. SST builds and pushes the image from that same `Dockerfile`; the steps below cover the SST-specific wiring — the service, secrets, and database. The `vite build` output (`dist/server.mjs`, started with `node dist/server.mjs`) and its runtime contract are unchanged from the [Node.js](/docs/ecosystem/deploy/node/) guide.

This guide was written against SST v3 (the Ion engine, the current major line). SST's component API moves quickly; confirm field names against the current [SST docs](https://sst.dev/docs/) for your installed version.

## The service

An `sst.aws.Service` runs on an `sst.aws.Cluster`, which needs an `sst.aws.Vpc`. The service builds the container from your `Dockerfile` and exposes it through a load balancer. Point the load balancer's `forward` port at the port your Dockerfile's server listens on — the [Docker](/docs/ecosystem/deploy/docker/) guide binds `PORT=8080`, so the examples below forward to `8080`.

```typescript title="sst.config.ts"
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'flue-agents',
      home: 'aws',
      removal: input.stage === 'production' ? 'retain' : 'remove',
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc('FlueVpc');
    const cluster = new sst.aws.Cluster('FlueCluster', { vpc });

    new sst.aws.Service('Flue', {
      cluster,
      image: { context: '.', dockerfile: 'Dockerfile' },
      loadBalancer: {
        rules: [{ listen: '80/http', forward: '8080/http' }],
      },
    });
  },
});
```

`sst deploy` builds the image from the `Dockerfile`, pushes it to ECR, and provisions the cluster, service, and load balancer. The service URL is printed at the end of the deploy.

## Environment and secrets

Flue's built server reads its provider key and model from the environment at start time. SST's `link` exposes resources through the `sst` SDK's `Resource` object at runtime, but the Flue server does not import that SDK — it reads plain `process.env`. So pass values the server needs through the service's `environment` field, not through `link` alone.

Define the provider key as an `sst.Secret` so its value stays out of source, then interpolate it into `environment`:

```typescript title="sst.config.ts"
const apiKey = new sst.Secret('AnthropicApiKey');

new sst.aws.Service('Flue', {
  cluster,
  image: { context: '.', dockerfile: 'Dockerfile' },
  loadBalancer: { rules: [{ listen: '80/http', forward: '8080/http' }] },
  link: [apiKey],
  environment: {
    ANTHROPIC_API_KEY: apiKey.value,
    MODEL_SPECIFIER: 'anthropic/claude-sonnet-4-6',
  },
});
```

Use `OPENAI_API_KEY` (and an `openai/...` `MODEL_SPECIFIER`) instead for OpenAI, matching the env var your provider expects. Set the secret's value once per stage with the CLI:

```bash
sst secret set AnthropicApiKey sk-...
```

Linking the secret grants the service permission to read it; the `environment` entry is what surfaces it to the Flue process as `process.env.ANTHROPIC_API_KEY`.

## Persistence

On a single Fargate task, Flue's canonical conversations, attachments, and accepted submissions live in memory, so they are lost when the task restarts or redeploys. Back them with Postgres when state must survive replacement or be available to replacement tasks. Shared storage does not enable active-active agent execution: route each agent instance to one live task.

The `sst.aws.Postgres` component provisions an RDS Postgres instance in the VPC and exposes its connection parts as outputs (`host`, `port`, `username`, `password`, `database`). Construct a `DATABASE_URL` from those with `$interpolate` and pass it through `environment`:

```typescript title="sst.config.ts"
const db = new sst.aws.Postgres('FlueDb', { vpc });

new sst.aws.Service('Flue', {
  cluster,
  image: { context: '.', dockerfile: 'Dockerfile' },
  loadBalancer: { rules: [{ listen: '80/http', forward: '8080/http' }] },
  link: [apiKey, db],
  environment: {
    ANTHROPIC_API_KEY: apiKey.value,
    MODEL_SPECIFIER: 'anthropic/claude-sonnet-4-6',
    DATABASE_URL: $interpolate`postgresql://${db.username}:${db.password}@${db.host}:${db.port}/${db.database}`,
  },
});
```

Install `@flue/postgres` and add a `db.ts` that wraps your configured `pg` pool and reads `DATABASE_URL` — see [Postgres](/docs/ecosystem/databases/postgres/) for the full bring-your-own-driver runner:

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

Flue discovers `db.ts` at build time and wires it into the generated server. The adapter handles schema creation, canonical conversation streams, immutable attachments, and durable submission state. Because the Postgres instance and the service share the VPC, the service reaches the database over the private network. See [Database](/docs/guide/database/) for the adapter contract and other backends.

## Health and streaming

The load balancer health-checks the service before it routes traffic, and the check defaults to path `/`. Flue does not generate a `/health` route — define one in `app.ts`, or the load balancer will treat the default health-check path as unhealthy if `/` doesn't return a `200`. Once that route exists, point the check at it through the service's `loadBalancer.health` field, which is keyed by the forwarded `'port/protocol'`:

```typescript title="sst.config.ts"
loadBalancer: {
  rules: [{ listen: '80/http', forward: '8080/http' }],
  health: {
    '8080/http': { path: '/health' },
  },
},
```

`sst.aws.Service` also accepts a container-level `health` command (run by ECS, e.g. `{ command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'] }`) if you prefer an ECS health check.

Agent conversations hold long-lived `GET` reads open on the conversation URL (long-poll or SSE). Load balancer idle timeouts can cut these off; for slow work, retain the admission's `streamUrl` and `offset`, raise the idle timeout, and resume the conversation stream rather than holding one blocking request. See the [Streaming Protocol](/docs/reference/streaming-protocol/).

## Going further

SST stages give you independent environments from one config — `sst deploy --stage production` and `sst deploy --stage dev` provision separate copies, and `sst secret set` scopes values per stage. Run `sst deploy` from CI or locally; `sst remove --stage <name>` tears a stage down. See the [SST docs](https://sst.dev/docs/) for autodeploy, custom domains on the load balancer, and scaling the service. Multiple tasks require shared durable storage plus instance-affine routing so one live task owns each agent instance.

## References

- [SST Service component](https://sst.dev/docs/component/aws/service/) — Fargate container service, load balancer, and health-check fields.
- [SST Postgres component](https://sst.dev/docs/component/aws/postgres/) — RDS Postgres and its `host`/`port`/`username`/`password`/`database` outputs.
- [SST Secret component](https://sst.dev/docs/component/secret/) — `new sst.Secret()`, `sst secret set`, and `.value`.
- [SST containers on AWS](https://sst.dev/docs/start/aws/container/) — official walkthrough for deploying a container service.
