---
title: Vercel Sandbox
description: Connect a Flue agent to an application-owned Vercel Sandbox environment.
lastReviewedAt: 2026-05-30
---

The Vercel Sandbox adapter adapts an initialized `@vercel/sandbox` `Sandbox` into Flue's sandbox interface. Use it when application code should execute agent work inside a Vercel-managed sandbox rather than on its host filesystem.

## Quickstart

Add managed Linux sandbox capability to an existing Flue project with the [Vercel Sandbox](https://vercel.com/sandbox) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox vercel
```

## Overview

The blueprint installs `@vercel/sandbox` when needed and creates `sandboxes/vercel.ts` in your source-root. The generated adapter accepts an initialized Vercel `Sandbox`; authentication, runtime selection, retention, and cleanup remain application-owned.

```ts title="<source-root>/sandboxes/vercel.ts (abridged)"
// flue-blueprint: sandbox/vercel@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as VercelSandbox } from '@vercel/sandbox';

class VercelSandboxApi implements SandboxApi {
  constructor(private sandbox: VercelSandbox) {}

  /* ... generated filesystem operations using sandbox.fs ... */

  async stat(path: string): Promise<FileStat> {
    const stat = await this.sandbox.fs.stat(path);
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      size: stat.size,
      mtime: stat.mtime,
    };
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutSignal =
      typeof options?.timeoutMs === 'number' ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const callerSignal = options?.signal;
    const signal =
      callerSignal && timeoutSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : (callerSignal ?? timeoutSignal);

    try {
      const response = await this.sandbox.runCommand({
        cmd: 'bash',
        args: ['-c', command],
        cwd: options?.cwd,
        env: options?.env,
        signal,
      });
      const [stdout, stderr] = await Promise.all([
        response.stdout({ signal }),
        response.stderr({ signal }),
      ]);
      return { stdout, stderr, exitCode: response.exitCode };
    } catch (err) {
      if (callerSignal?.aborted) throw err;
      const aborted =
        timeoutSignal?.aborted &&
        (err === timeoutSignal.reason ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')));
      if (aborted) {
        return {
          stdout: '',
          stderr: `[flue:vercel] Command timed out after ${options?.timeoutMs} milliseconds.`,
          exitCode: 124,
        };
      }
      throw err;
    }
  }
}

export function vercel(sandbox: VercelSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/vercel/sandbox';
      const api = new VercelSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized Vercel `Sandbox` to `vercel(...)` and assign the returned factory to an agent's `sandbox` property. The adapter maps the provider's complete file stat, resolves relative paths from `/vercel/sandbox`, forwards a composed signal to command execution and output reads, propagates caller cancellation, and maps only `timeoutMs` cancellation to exit code 124.

## Configure

| Variable            | Purpose                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_OIDC_TOKEN` | **Required for OIDC authentication** — Injected automatically on Vercel; set it explicitly when using OIDC locally. |

| Requirement                     | Purpose                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Vercel-supported authentication | **Required** — Uses OIDC on Vercel or an access token or other supported authentication flow outside Vercel. |
| `@vercel/sandbox` package       | **Required** — Creates the Vercel Sandbox adapted by Flue.                                                   |
| Application-owned lifecycle     | **Required** — Creates the sandbox and decides its retention and cleanup.                                    |

## Typical use

```ts
import { Sandbox } from '@vercel/sandbox';
import { defineAgent } from '@flue/runtime';
import { vercel } from '../sandboxes/vercel';

const sandbox = await Sandbox.create({ runtime: 'node24' });
const agent = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: vercel(sandbox),
}));
```

Keep Vercel authentication values in trusted application configuration and determine whether sandboxes should be fresh per job or reusable for stable agent identities.

See [Sandboxes](/docs/guide/sandboxes/) and [Sandbox Adapter API](/docs/api/sandbox-api/).
