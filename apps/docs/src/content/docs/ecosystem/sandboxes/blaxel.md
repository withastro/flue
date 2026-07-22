---
title: Blaxel
description: Connect a Flue agent to an application-owned Blaxel sandbox.
lastReviewedAt: 2026-07-22
---

The Blaxel adapter adapts an initialized `SandboxInstance` from `@blaxel/core` into Flue's sandbox interface. Use it when a Node-hosted application needs a perpetual Blaxel microVM with filesystem and shell operations.

## Quickstart

Add Blaxel sandbox capability to an existing Flue project with the [Blaxel](https://blaxel.ai) blueprint:

```bash
flue add sandbox blaxel
```

## Overview

The blueprint installs `@blaxel/core` when needed and creates `sandboxes/blaxel.ts` in your source root. The generated file adapts a sandbox that your application has already created; it does not choose its identity, retention, or cleanup policy.

```ts title="<source-root>/sandboxes/blaxel.ts (abridged)"
// flue-blueprint: sandbox/blaxel@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { FileStat, SandboxApi, SandboxFactory, SessionEnv } from '@flue/runtime';
import type { SandboxInstance } from '@blaxel/core';

class BlaxelSandboxApi implements SandboxApi {
  constructor(private sandbox: SandboxInstance) {}

  /* Uses sandbox.fs for text and binary reads and writes. */

  /* Derives stat and readdir from sandbox.fs.ls directory entries. */

  /* Uses sandbox.process.exec with waitForCompletion and a rounded-up timeout. */
}

export function blaxel(sandbox: SandboxInstance): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      return createSandboxSessionEnv(new BlaxelSandboxApi(sandbox), '/blaxel');
    },
  };
}
```

Pass an initialized `SandboxInstance` to `blaxel(...)`, then assign the returned factory to an agent's `sandbox` property. Flue roots sessions at Blaxel's `/blaxel` working directory, exposes text and binary filesystem operations, and executes commands through the sandbox process API. Millisecond Flue deadlines are rounded up to Blaxel's whole-second process timeout. Blaxel supports recursive removal but has no force-delete flag in its filesystem API, so the adapter rejects `force` before mutation. Your application remains responsible for sandbox creation and lifecycle.

## Configure

For local development, authenticate with `bl login <workspace>`. For CI or another non-Blaxel host, provide these runtime variables:

| Variable       | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `BL_WORKSPACE` | Selects the Blaxel workspace.                   |
| `BL_API_KEY`   | Authenticates the SDK outside a Blaxel runtime. |

| Requirement                 | Purpose                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `@blaxel/core` package      | **Required** — Creates the Blaxel sandbox adapted by Flue.                                     |
| Application-owned lifecycle | **Required** — Creates, retains, and deletes the sandbox, then passes it to `blaxel(sandbox)`. |

Workloads running on Blaxel authenticate automatically. The generated adapter never stores credentials and never deletes the sandbox when a Flue harness closes.

## Typical use

```ts
import { SandboxInstance } from '@blaxel/core';
import { defineAgent } from '@flue/runtime';
import { blaxel } from '../sandboxes/blaxel';

const sandbox = await SandboxInstance.createIfNotExists({
  name: 'my-flue-sandbox',
  image: 'blaxel/base-image:latest',
  memory: 4096,
  region: 'us-pdx-1',
  ttl: '24h',
});

const agent = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: blaxel(sandbox),
}));
```

Configure images, regions, lifecycle, networking, volumes, and Agent Drive mounts through `@blaxel/core` before passing the instance to `blaxel(...)`. For a narrower working directory, configure `cwd` on the agent definition; Flue resolves it against the adapter's `/blaxel` base directory during initialization.

See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes), [Sandbox Adapter API](/docs/api/sandbox-api/), and [Blaxel's TypeScript SDK reference](https://docs.blaxel.ai/Sandboxes/Overview).
