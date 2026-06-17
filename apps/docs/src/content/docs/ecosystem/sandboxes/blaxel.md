---
title: Blaxel
description: Connect a Flue agent to an application-owned Blaxel sandbox.
lastReviewedAt: 2026-06-17
---

The Blaxel adapter adapts an initialized `@blaxel/core` `SandboxInstance` into Flue's sandbox interface. Use it when application code should run agent file and shell work inside a Blaxel-managed Linux sandbox while the application owns sandbox creation, image selection, retention, and cleanup.

## Quickstart

Add Blaxel sandbox capability to an existing Flue project with the [Blaxel](https://blaxel.ai) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox blaxel
```

## Overview

The blueprint installs `@blaxel/core` when needed and creates `sandboxes/blaxel.ts` in your source-root. The generated adapter accepts an initialized Blaxel `SandboxInstance`; authentication, region, image, memory, labels, volumes, environment, retention, and deletion remain application-owned.

```ts title="<source-root>/sandboxes/blaxel.ts (abridged)"
// flue-blueprint: sandbox/blaxel@1
import type { SandboxInstance } from '@blaxel/core';
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, ShellResult } from '@flue/runtime';

export interface BlaxelSandboxOptions {
  cwd?: string;
}

export function blaxel(
  sandbox: SandboxInstance,
  options: BlaxelSandboxOptions = {},
): SandboxFactory {
  const cwd = options.cwd ?? '/tmp';
  const api = new BlaxelSandboxApi(sandbox);

  return {
    async createSessionEnv(_options: { id: string }): Promise<SessionEnv> {
      return createSandboxSessionEnv(api, cwd);
    },
  };
}

class BlaxelSandboxApi implements SandboxApi {
  constructor(private readonly sandbox: SandboxInstance) {}

  /* Implements file reads, binary reads, writes, stat, listing, existence, mkdir, and rm with sandbox.fs. */

  async exec(command: string, options?: Parameters<SandboxApi['exec']>[1]): Promise<ShellResult> {
    /* Runs short commands with sandbox.process.exec(..., waitForCompletion: true). */
    /* Runs longer commands with named processes, wait(), logs(), timeout handling, and abort cleanup. */
  }
}
```

Pass an initialized Blaxel `SandboxInstance` to `blaxel(...)` and assign the returned factory to an agent's `sandbox` property. The adapter maps Blaxel file operations to Flue's session filesystem, executes shell commands through Blaxel processes, preserves stdout, stderr, and exit codes, maps command timeouts to exit code 124, and kills named long-running processes on timeout or caller abort.

The adapter defaults to `/tmp`, which exists in Blaxel's base image and works well for scratch files. If your image prepares a project workspace elsewhere, pass `blaxel(sandbox, { cwd: '/path' })`; Flue resolves agent `cwd` values relative to that adapter base during `init()`.

## Configure

| Variable         | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `BL_WORKSPACE`   | Optional workspace selection for Blaxel SDK/CLI usage. |
| Blaxel auth envs | Required according to your application's Blaxel setup. |

| Requirement                 | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `@blaxel/core` package      | **Required** — Creates the Blaxel sandbox adapted by Flue.           |
| Provider-managed sandbox    | **Required** — Supplies the command and filesystem environment.      |
| Application-owned lifecycle | **Required** — Creates, waits for, retains, and deletes the sandbox. |

## Typical use

```ts
import { SandboxInstance } from '@blaxel/core';
import { createAgent } from '@flue/runtime';
import { blaxel } from '../sandboxes/blaxel';

const sandbox = await SandboxInstance.createIfNotExists({
  name: 'flue-blaxel',
  image: 'blaxel/base-image:latest',
  memory: 4096,
  region: process.env.BL_REGION ?? 'us-pdx-1',
});
await sandbox.wait({ interval: 3000, maxWait: 180_000 });

const agent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: blaxel(sandbox),
}));
```

Use the Blaxel SDK for image, region, memory, labels, volumes, environment, retention, and deletion policy. For first local verification, set `model: false` and exercise `harness.session().shell(...)`, `session.fs`, `harness.fs`, and cleanup against a disposable sandbox before enabling a paid model.

See [Sandboxes](/docs/guide/sandboxes/), [Sandbox Adapter API](/docs/api/sandbox-api/), and [Blaxel's documentation](https://docs.blaxel.ai/).
