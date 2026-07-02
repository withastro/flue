---
title: Microsandbox
description: Connect a Flue agent to an application-owned Microsandbox sandbox.
lastReviewedAt: 2026-07-02
---

The Microsandbox adapter adapts an already-initialized [Microsandbox](https://microsandbox.dev) `Sandbox` from the `microsandbox` SDK into Flue's sandbox interface. Use it when a Node-hosted application needs a self-hosted, hardware-isolated microVM environment with filesystem and shell operations.

## Quickstart

Add self-hosted microVM sandbox capability to an existing Flue project with the [Microsandbox](https://microsandbox.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox microsandbox
```

## Overview

The blueprint installs `microsandbox` when needed and creates `sandboxes/microsandbox.ts` in your source-root. That file adapts a Microsandbox sandbox that your application has already created; it does not choose its image, name, retention, or cleanup policy.

```ts title="<source-root>/sandboxes/microsandbox.ts (abridged)"
// flue-blueprint: sandbox/microsandbox@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import { ExecTimeoutError } from 'microsandbox';
import type { Sandbox as MicrosandboxSandbox, SandboxFsOps } from 'microsandbox';

class MicrosandboxSandboxApi implements SandboxApi {
  constructor(private sandbox: MicrosandboxSandbox) {}

  /* Implements file reads, writes, stat, listing, existence, and single-level mkdir with sandbox.fs(). */

  /* Rejects unsupported recursive/force removal, trying file removal before directory removal. */

  /* Implements exec() via sh -c '<command>' over execStreamWith(), forwarding cwd, env, and timeoutMs
     unchanged (no rounding needed) and cancelling mid-flight through the streaming handle's kill(). */
}

export function microsandbox(sandbox: MicrosandboxSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/';
      const api = new MicrosandboxSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized Microsandbox `Sandbox` to `microsandbox(...)`, then assign the returned factory to an agent's `sandbox` property. Flue exposes Microsandbox filesystem and command operations through the session and forwards millisecond command deadlines to the SDK's native `timeout()` option unchanged. Microsandbox's filesystem API only removes files and empty directories one level at a time, so the adapter rejects `recursive` and `force` removal options before mutating. Your application remains responsible for sandbox creation, naming, and lifecycle.

## Configure

Microsandbox needs no API key for local sandboxes — the `microsandbox` npm package embeds the runtime through a native addon and boots microVMs directly on the host.

| Requirement                                                              | Purpose                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Hardware virtualization (Linux KVM, macOS Apple Silicon, or Windows WHP) | **Required** — `Sandbox.builder(...).create()` fails without it.                                          |
| `microsandbox` package                                                   | **Required** — Creates the Microsandbox sandbox adapted by Flue.                                          |
| Application-owned lifecycle                                              | **Required** — Creates, names, retains, and stops the sandbox, then passes it to `microsandbox(sandbox)`. |

If the platform-specific `@superradcompany/microsandbox-<platform>` optional dependency is missing (for example, optional dependencies were disabled during install), reinstall with optional dependencies enabled, add that package explicitly, or set `MSB_PATH` to a working `msb` binary.

The generated adapter expects your application to create and own the Microsandbox sandbox. It does not decide sandbox naming, retention, or cleanup for you.

## Typical use

```ts
import { Sandbox } from 'microsandbox';
import { defineAgent } from '@flue/runtime';
import { microsandbox } from '../sandboxes/microsandbox';

const sandbox = await Sandbox.builder(`agent-${Date.now()}`).image('python').replace().create();

const agent = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: microsandbox(sandbox),
}));
```

Configure images, resources, networking, volumes, and secrets through the Microsandbox SDK's builder before passing the sandbox to `microsandbox(...)`. Every sandbox needs an explicit `name`; chain `.replace()` so a retried agent run doesn't throw `SandboxAlreadyExistsError` on a name collision, and use `.maxDuration(secs)` or `.idleTimeout(secs)` if you want sandboxes to expire on their own, since Flue does not manage sandbox lifetime. For a narrower working directory, configure `cwd` on the agent definition; Flue resolves it once against the adapter's provider-owned base directory during `init()`.

See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes), [Sandbox Adapter API](/docs/api/sandbox-api/), and [Microsandbox's TypeScript SDK reference](https://docs.microsandbox.dev/sdk/typescript/sandbox).
