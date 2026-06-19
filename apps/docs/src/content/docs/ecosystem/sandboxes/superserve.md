---
title: Superserve
description: Connect a Flue agent to an application-owned Superserve sandbox.
lastReviewedAt: 2026-06-18
---

The Superserve adapter adapts an already-initialized Superserve sandbox from the `@superserve/sdk` package into Flue's sandbox interface. Use it for provider-managed Firecracker microVM execution when an agent needs shell commands and workspace files that persist across a session.

## Quickstart

Add provider-managed Linux sandbox capability to an existing Flue project with the [Superserve](https://superserve.ai) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox superserve
```

## Overview

The Superserve blueprint installs `@superserve/sdk` when needed and creates `sandboxes/superserve.ts` in your source-root. The generated adapter accepts an application-created Superserve `Sandbox`; provisioning, template selection, credentials, and shutdown remain outside the adapter.

```ts title="<source-root>/sandboxes/superserve.ts (abridged)"
// flue-blueprint: sandbox/superserve@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as SuperserveSandbox } from '@superserve/sdk';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class SuperserveSandboxApi implements SandboxApi {
  constructor(private sandbox: SuperserveSandbox) {}

  /* Reads and writes files with sandbox.files.readText, read, and write. */

  /* Implements stat, readdir, exists, mkdir, and rm with quoted GNU shell utilities. */

  /* Runs commands with sandbox.commands.run(), forwards timeoutMs and signal, and maps a timeout to exit code 124. */
}

export function superserve(sandbox: SuperserveSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/home/user';
      const api = new SuperserveSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Passing `superserve(sandbox)` as an agent's `sandbox` exposes the created Superserve sandbox's files and command execution through Flue, with relative paths rooted at `/home/user`. File reads and writes use Superserve's data-plane file API; `stat`, `readdir`, `exists`, `mkdir`, and `rm` shell out, so the sandbox's template must provide GNU coreutils, which the default `superserve/base` image (Ubuntu 24.04) does. The generated `rm` receives the requested recursive and force flags, and a command that exceeds its `timeoutMs` resolves to exit code `124` rather than throwing.

`superserve/base` is otherwise minimal — `git`, `curl`, and coreutils on Ubuntu 24.04, with no language runtimes. When the agent shells out to tooling such as `node` or `python`, boot from a curated template like `superserve/node-22` or `superserve/python-3.11`, or a custom template, via `Sandbox.create({ fromTemplate })`.

## Configure

| Variable              | Purpose                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `SUPERSERVE_API_KEY`  | **Required** — Authenticates the SDK with the Superserve control plane; read from the environment automatically. |

| Requirement                 | Purpose                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `@superserve/sdk` package   | **Required** — Provides the Superserve TypeScript SDK.                                        |
| Template with GNU coreutils | **Required** — Provides the shell utilities used for filesystem operations the SDK does not expose. |

## Choose this adapter when

Use Superserve when your application already manages Superserve sandbox lifetimes — creation, pausing, templates, and shutdown — and needs to expose that microVM boundary to Flue operations. The adapter adapts the created sandbox; creation, shutdown, secret handling, networking, and template content remain your responsibility.

See [Sandboxes](/docs/guide/sandboxes/) and [Sandbox Adapter API](/docs/api/sandbox-api/).
