---
title: Daytona
description: Connect a Flue agent to an application-owned Daytona sandbox.
lastReviewedAt: 2026-06-01
---

The Daytona adapter adapts an already-initialized Daytona sandbox from `@daytona/sdk` into Flue's sandbox interface. Use it when a Node-hosted application needs a provider-managed Linux environment with filesystem and shell operations.

## Quickstart

Add provider-managed Linux sandbox capability to an existing Flue project with the [Daytona](https://daytona.io) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox daytona
```

## Overview

The blueprint installs `@daytona/sdk` when needed and creates `sandboxes/daytona.ts` in your source-root. That file adapts a Daytona sandbox that your application has already created; it does not choose its image, identity, retention, or cleanup policy.

```ts title="<source-root>/sandboxes/daytona.ts (abridged)"
// flue-blueprint: sandbox/daytona@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';

class DaytonaSandboxApi implements SandboxApi {
  constructor(private sandbox: DaytonaSandbox) {}

  /* Implements file reads, writes, stat, listing, existence, and mkdir with sandbox.fs. */

  /* Forwards recursive removal and rejects unsupported force before deletion. */

  /* Implements exec() with executeCommand(), rounding timeoutMs up to whole seconds. */
}

export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = (await sandbox.getWorkDir()) ?? '/home/daytona';
      const api = new DaytonaSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized Daytona `Sandbox` to `daytona(...)`, then assign the returned factory to an agent's `sandbox` property. Flue uses the provider's working directory as the workspace root, exposes Daytona filesystem and process operations through the session, preserves Daytona's available file metadata, and rounds millisecond command deadlines up to the SDK's whole-second timeout. Daytona supports recursive deletion but not force semantics, so the adapter rejects `force` before deletion. Your application remains responsible for sandbox creation and lifecycle.

## Configure

| Variable          | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `DAYTONA_API_KEY` | **Required** — Authenticates with the Daytona API. |

| Requirement                 | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `@daytona/sdk` package      | **Required** — Creates the Daytona sandbox adapted by Flue.                                     |
| Application-owned lifecycle | **Required** — Creates, retains, and deletes the sandbox, then passes it to `daytona(sandbox)`. |

The generated adapter expects your application to create and own the Daytona sandbox. It does not decide sandbox identity, retention, or cleanup for you.

## Typical use

```ts
import { Daytona } from '@daytona/sdk';
import { daytona } from '../sandboxes/daytona';

const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
const sandbox = await client.create();
const harness = await ctx.init({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: daytona(sandbox),
});
```

Configure images, snapshots, regions, environment variables, and volumes through the Daytona SDK before passing the sandbox to `daytona(...)`. For a narrower working directory, configure `cwd` in the runtime config; Flue resolves it once against the adapter's provider-owned base directory during `init()`.

See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes), [Sandbox Adapter API](/docs/api/sandbox-api/), and [Daytona's TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/daytona/).
