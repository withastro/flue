---
title: islo
description: Connect a Node-target Flue application to a named islo sandbox through its CLI.
lastReviewedAt: 2026-07-21
---

The islo adapter adapts a named islo sandbox into Flue's sandbox interface by invoking the local `islo` CLI. It is designed for a Node.js server, container, or CI runner where the binary is installed and can launch remote commands.

## Quickstart

Add named remote sandbox capability to an existing Flue project with the [islo](https://islo.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox islo
```

## Overview

The islo blueprint creates `sandboxes/islo.ts` in your source-root without adding an npm dependency. The generated adapter uses Node's child-process API and expects an authenticated `islo` binary plus an application-managed sandbox name.

```ts title="<source-root>/sandboxes/islo.ts (abridged)"
// flue-blueprint: sandbox/islo@1
import { spawn } from 'node:child_process';
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';

export interface IsloAdapterOptions {
  cwd?: string;
  cliPath?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

class IsloSandboxApi implements SandboxApi {
  constructor(
    private name: string,
    private cliPath: string,
  ) {}

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cd = options?.cwd ? `cd ${q(options.cwd)} && ` : '';
    const envPrefix = options?.env
      ? Object.entries(options.env)
          .map(([k, v]) => `${k}=${q(v)}`)
          .join(' ') + ' '
      : '';
    const tmo =
      typeof options?.timeoutMs === 'number' ? `timeout ${options.timeoutMs / 1000} ` : '';
    const remote = `${envPrefix}${tmo}bash -lc ${q(cd + command)}`;
    const args = ['--output', 'json', 'use', this.name, '--', 'bash', '-lc', remote];

    /* ... spawn the islo CLI and map its output and exit code ... */
  }

  /* ... generated file operations using quoted remote shell commands ... */
}

export function islo(name: string, options?: IsloAdapterOptions): SandboxFactory {
  const cliPath = options?.cliPath ?? 'islo';
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = options?.cwd ?? '/workspace';
      const api = new IsloSandboxApi(name, cliPath);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass a sandbox name to `islo(...)` and assign the returned factory to an agent's `sandbox` property. Flue resolves relative paths from `/workspace`; the adapter converts `timeoutMs` from milliseconds to seconds for GNU `timeout` inside the sandbox, while the CLI handles remote execution and file operations.

## Configure

| Variable       | Purpose                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ISLO_API_KEY` | **Alternative authentication** — Authenticates server or CI operation when existing CLI authentication is unavailable. |

| Requirement                            | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Existing CLI authentication or API key | **Required** — Authenticates through the CLI session or `ISLO_API_KEY`.   |
| Node.js child-process capability       | **Required** — Allows the adapter to invoke the CLI.                      |
| `islo` binary on `PATH`                | **Required** — Executes remote shell and file operations.                 |
| Named islo sandbox                     | **Required** — Identifies the application- or deployment-managed sandbox. |

## Choose this adapter when

Use islo when an application can rely on a host-installed CLI and wants to connect to named sandboxes from a Node execution environment. Do not use it in Cloudflare Workers or other runtimes that cannot execute native child processes.

The adapter runs remote shell/file work through the CLI; ensure its host process, credentials, and agent inputs match your intended trust boundary.

See [Deploy on Node.js](/docs/ecosystem/deploy/node/), [Sandboxes](/docs/guide/sandboxes/), and [Sandbox Adapter API](/docs/reference/sandbox-api/).
