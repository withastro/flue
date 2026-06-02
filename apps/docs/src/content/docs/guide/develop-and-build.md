---
title: Develop & Build
description: Develop a Flue application locally, build and run it, and continue to deployment.
lastReviewedAt: 2026-05-30
---

Use the Flue CLI to develop your application locally, invoke agents and workflows directly, and build the output you deploy.

This guide covers that lifecycle. For source files and discovery conventions, see [Project Layout](/docs/guide/project-layout/). For the routes your application exposes, see [Routing](/docs/guide/routing/).

## Develop

`flue dev` is the local development server for a Flue application. It builds the discovered agents, workflows, optional `app.ts`, and optional Cloudflare-only `cloudflare.ts`, serves the application locally, and rebuilds as source files change.

After selecting your normal runtime target in `flue.config.ts`, start the development server:

```bash
pnpm exec flue dev
```

Use development mode to exercise the same routes and transports that callers will use. Agents and workflows are not public merely because they are built; see [Routing](/docs/guide/routing/) to expose them or add application-owned routes such as webhooks.

Keep local credentials and platform values in environment configuration rather than agent source. See [Configuration](/docs/reference/configuration/) to choose a runtime target, pass a one-time CLI override, or provide local environment values.

## Run

The CLI can invoke discovered agents and workflows directly through a local Node build. This is useful when you want to exercise application behavior without first exposing or calling an HTTP or WebSocket route.

Use `flue connect` to open an interactive connection to one agent instance:

```bash
pnpm exec flue connect support-assistant ticket-8472
```

The connection remains open for multiple prompts, so the agent instance and session can continue accumulating context as you work. See the [`flue connect` CLI reference](/docs/cli/connect/) for command options.

Use `flue run` to invoke one finite workflow locally, from a script, or as a CI job:

```bash
pnpm exec flue run summarize-ticket --payload '{"ticket":"Ticket details"}'
```

`flue run` prints the workflow result and exits. See the [`flue run` CLI reference](/docs/cli/run/) for command options.

Both commands are local Node execution paths. A deployed application receives input through the routes and transports it publishes; see [Routing](/docs/guide/routing/) for that boundary.

## Build

`flue build` creates the generated application output that you hand to a deployment environment. Run it before deployment to catch build-time errors and confirm that Flue discovers the agents and workflows you intend to include:

```bash
pnpm exec flue build
```

The build uses that configured target, or a one-time `--target` override, to produce deployable output in `dist/` by default. See [Configuration](/docs/reference/configuration/) to change the output directory.

A build packages the application for its runtime environment. It does not choose a model, add provider credentials, expose additional routes, or configure platform-owned bindings. Keep those concerns in your authored application modules, secrets configuration, and deployment-platform configuration. Cloudflare applications may add platform-specific Worker exports and non-HTTP handlers in `cloudflare.ts`; see [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/#extending-the-worker).

## Deploy

Once the application builds and runs in the form you need, follow the [deployment ecosystem guides](/docs/ecosystem/overview/) for your destination, including [Node.js](/docs/ecosystem/deploy/node/), [Cloudflare](/docs/ecosystem/deploy/cloudflare/), managed hosting, and CI workflow execution.

Treat deployment as more than uploading build output: provide secrets and platform bindings, verify application-owned routes such as health checks and webhook ingress, and test any state or workspace behavior that must survive beyond one local process. See [Agents](/docs/guide/building-agents/) and the [Data Persistence API](/docs/api/data-persistence-api/) for session continuity, [Sandboxes](/docs/guide/sandboxes/) for workspace behavior, and [Observability](/docs/guide/observability/) for operating an application after deployment.
