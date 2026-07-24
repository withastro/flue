---
title: E2B
description: Connect a Flue agent to an E2B Linux sandbox.
lastReviewedAt: 2026-07-21
---

The E2B adapter adapts an initialized E2B sandbox from the `e2b` package into Flue's sandbox interface. Use it for provider-managed Linux execution when an agent needs shell commands and workspace files outside the application host.

## Quickstart

Add provider-managed Linux sandbox capability to an existing Flue project with the [E2B](https://e2b.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox e2b
```

## Overview

The blueprint installs `e2b` when needed and creates `sandboxes/e2b.ts` in your source-root. That file adapts an E2B sandbox that your application has already created; it does not create, retain, or close provider resources.

```ts title="<source-root>/sandboxes/e2b.ts (abridged)"
// flue-blueprint: sandbox/e2b@1
import { createSandboxSessionEnv, useModel } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as E2BSandbox } from 'e2b';

class E2BSandboxApi implements SandboxApi {
  constructor(private sandbox: E2BSandbox) {}

  /* Implements file reads, writes, stat, listing, existence, and mkdir with sandbox.files. */

  /* Rejects recursive or force before calling sandbox.files.remove(). */

  /* Implements exec() with sandbox.commands.run(), forwarding timeoutMs unchanged. */
}

export function e2b(sandbox: E2BSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/home/user';
      const api = new E2BSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized E2B `Sandbox` to `e2b(...)`, then pass the returned factory to the agent's `useSandbox(...)` call. Flue resolves workspace paths from `/home/user`, exposes E2B's files and commands through session operations, forwards command timeouts in milliseconds, and reports only the file metadata E2B exposes. E2B's direct remove API has no recursive or force controls, so the adapter rejects either option before deletion. Your application remains responsible for sandbox configuration and lifecycle.

## Configure

| Variable      | Purpose                                        |
| ------------- | ---------------------------------------------- |
| `E2B_API_KEY` | **Required** — Authenticates with the E2B API. |

| Requirement                    | Purpose                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `e2b` package                  | **Required** — Provides the initialized E2B sandbox adapted by Flue.        |
| Provider-managed Linux sandbox | **Required** — Supplies the command and filesystem environment.             |
| Application-owned lifecycle    | **Required** — Creates the sandbox and closes or retains it as appropriate. |

## Integration shape

```ts
import { Sandbox } from 'e2b';
import { useModel, useSandbox } from '@flue/runtime';
import { e2b } from '../sandboxes/e2b';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    // Lazy, per the SandboxFactory contract: constructing this object is
    // cheap; the expensive E2B sandbox creation happens once, inside
    // createSessionEnv(), at initialization — never on a re-render.
    async createSessionEnv(options) {
      const sandbox = await Sandbox.create();
      return e2b(sandbox).createSessionEnv(options);
    },
  });
}
```

Select templates, timeouts, network access, secret exposure, and resource reuse through your application and provider policy. Flue adapts the active environment; it does not choose provider retention for you.

See [Sandboxes](/docs/guide/sandboxes/) and [Sandbox Adapter API](/docs/reference/sandbox-api/).
