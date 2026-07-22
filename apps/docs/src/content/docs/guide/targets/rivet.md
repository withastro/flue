---
title: Rivet
description: Understand the Rivet target for Flue applications.
---

The Rivet target runs Flue agents and workflows on Rivet Actors. Each agent instance and workflow run is addressed by actor key, while Flue keeps the same public HTTP API for prompts, workflow starts, Durable Streams reads, and `dispatch(...)`.

Install the Rivet target package and select it in your Flue config:

```bash
pnpm add @rivet-dev/flue
```

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';
import rivet from '@rivet-dev/flue';

export default defineConfig({
  target: rivet,
});
```

## Runtime Model

Rivet Actors give each Flue agent instance one durable execution home. Direct HTTP prompts and `dispatch(...)` inputs enter the same durable admission path, so accepted work can recover after interruption through the actor `onWake` lifecycle.

Workflow runs are one actor per run. A restarted workflow actor does not replay the workflow body; if its stored run is still active, Flue marks the run as interrupted and closes its event stream. Start a new workflow run explicitly when retry is appropriate.

## Local Development

Use the standard Flue commands after selecting `target: rivet`:

```bash
pnpm exec flue dev
pnpm exec flue build
```

The generated HTTP surface stays the same as the Node and Cloudflare targets:

- `POST /agents/:name/:id`
- `GET /agents/:name/:id`
- `POST /workflows/:name`
- `GET /runs/:runId`

For deployment options, see [Deploy to Rivet](/docs/ecosystem/deploy/rivet/) and [Deploy to Vercel with Rivet](/docs/ecosystem/deploy/vercel/).
