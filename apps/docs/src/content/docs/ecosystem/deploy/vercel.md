---
title: Deploy to Vercel with Rivet
description: Mount Flue and Rivet route handlers in a Next.js app deployed to Vercel.
---

Flue can run on Vercel through the Rivet Next.js driver. The app mounts two catch-all routes:

- `/api/rivet/[...all]` is the Rivet actor gateway.
- `/api/flue/[...all]` is Flue's public HTTP API for agents, workflows, and runs.

## Routes

```ts title="app/api/rivet/[...all]/route.ts"
import { toNextHandler } from '@rivetkit/next-js';
import { registry } from '../../../../dist/server.mjs';

export const maxDuration = 300;

export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } = toNextHandler(registry);
```

```ts title="app/api/flue/[...all]/route.ts"
import { toFlueNextHandler } from '@rivet-dev/flue/next';
import { flueApp } from '../../../../dist/server.mjs';

export const maxDuration = 300;

export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } = toFlueNextHandler(flueApp);
```

Run `flue build` before starting or building the Next.js app so `dist/server.mjs` exists.

## Serverless Limit

Vercel functions are bounded by `maxDuration`. The examples use `300`, the practical upper bound for this hosting mode. If an agent turn runs longer than the function lifespan, Vercel can stop the invocation; Flue then relies on Rivet `onWake` recovery the next time the actor is invoked.

Use this mode for chat, request/response agents, and short workflows. Use a standalone Rivet runner for long autonomous turns that should not be capped by a serverless function duration.
