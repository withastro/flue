---
title: Deploy to Rivet
description: Build and run Flue agents with the Rivet target.
---

Use the Rivet target when you want Flue agents and workflows to run on Rivet actors instead of a single Node process or Cloudflare Durable Objects.

## Install

```bash
pnpm add @rivetkit/flue rivetkit
pnpm add -D @flue/cli
```

Configure Flue:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';
import rivet from '@rivetkit/flue';

export default defineConfig({
  target: rivet,
});
```

## Build

```bash
pnpm exec flue build
```

The build emits a server artifact that exposes Flue's front door and wires requests to Rivet-backed agent and workflow actors. The same artifact can be run standalone for local development, or imported by a host such as Next.js when using the Vercel route pattern.

## Runtime Behavior

Agent prompts and `dispatch(...)` inputs are durably admitted before execution. Workflow runs are indexed for `/runs/:runId` lookups and Durable Streams reads. On actor wake, Flue reconciles interrupted agent submissions and terminalizes interrupted workflow runs so callers do not wait forever on an active run that can no longer complete.

For target-specific details, see [Rivet Target](/docs/guide/targets/rivet/).
