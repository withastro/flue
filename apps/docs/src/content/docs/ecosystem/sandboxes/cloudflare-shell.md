---
title: Cloudflare Shell
description: Use a durable Cloudflare Workspace with code-oriented agent operations.
lastReviewedAt: 2026-07-21
---

The Cloudflare Shell adapter adapts an application-owned `@cloudflare/shell` `Workspace` into a Flue sandbox on the Cloudflare target. Unlike a Linux shell sandbox, it provides a durable workspace. The model keeps the standard file tools (`read`/`write`/`edit`, routed through the workspace) and gains a `code` tool that executes JavaScript against workspace state through a Worker Loader binding, in place of the shell-backed `bash`/`grep`/`glob`.

## Quickstart

Add durable workspace sandbox capability to an existing Flue project with the [Cloudflare Shell](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare-shell
```

## Overview

The blueprint installs `@cloudflare/shell` and `@cloudflare/codemode`, creates `<source-root>/sandboxes/cloudflare-shell.ts`, and adds a Worker Loader binding to Wrangler configuration. The generated adapter exports sandbox construction and default workspace helpers; its file API retries nested writes after recursively creating a missing parent directory.

```ts title="<source-root>/sandboxes/cloudflare-shell.ts (abridged)"
// flue-blueprint: sandbox/cloudflare-shell@2
import { Workspace, WorkspaceFileSystem /* ... */ } from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
import { DynamicWorkerExecutor, resolveProvider /* ... */ } from '@cloudflare/codemode';
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type SandboxFactory,
  type SessionToolFactory /* ... */,
} from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export interface GetShellSandboxOptions {
  workspace: Workspace;
  loader: WorkerLoader;
  executor?: Pick<DynamicWorkerExecutorOptions, 'timeout' | 'globalOutbound' | 'modules'>;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
  /* ... generated workspace and Worker Loader validation ... */

  const { workspace, loader, executor: executorOptions } = options;
  const fs = new WorkspaceFileSystem(workspace);
  const executor = new DynamicWorkerExecutor({
    loader,
    ...executorOptions,
  });
  const stateProvider = resolveProvider(stateTools(workspace));
  // Compose the standard file tools with this sandbox's native codemode
  // tool; the exec-backed bash/grep/glob stay out — this env has no shell.
  const toolFactory: SessionToolFactory = (env) => [
    createReadTool(env),
    createWriteTool(env),
    createEditTool(env),
    createCodeTool(executor, stateProvider),
  ];

  return {
    async createSessionEnv(): Promise<ShellSandboxEnv> {
      return { ...createWorkspaceSessionEnv(workspace, fs, '/'), workspace };
    },
    tools: toolFactory,
  };
}

/* ... generated workspace session environment and code tool implementation ... */

export function getDefaultWorkspace(): Workspace {
  const { storage } = getCloudflareContext();
  return new Workspace({ sql: storage.sql });
}
```

Create a workspace, then pass it with the `worker_loaders` binding to `getShellSandbox(...)`. Agents receive durable file operations — the standard `read`/`write`/`edit` tools composed from Flue's exported per-tool factories — and the isolated JavaScript `code` tool; they do not receive Linux command execution. Application-specific data loading into the workspace remains application-owned.

The generated `code` tool bounds its own concurrency: Cloudflare allows at most 4 concurrent dynamic-worker invocations per request, and Flue executes a turn's tool calls in parallel, so the adapter queues `code` executions above a cap of 3 rather than letting the platform reject the surplus calls.

## Configure

| Requirement                               | Purpose                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare target                         | **Required** — Runs the Workspace and Worker Loader integration.                                                                     |
| `@cloudflare/shell` package               | **Required** — Provides the durable Workspace.                                                                                       |
| `@cloudflare/codemode` package            | **Required** — Provides code-oriented model operations.                                                                              |
| `worker_loaders` binding such as `LOADER` | **Required on Cloudflare** — Executes JavaScript against Workspace state; this is a Cloudflare binding, not an environment variable. |
| Environment-variable credentials          | **Not required** — The integration uses the `worker_loaders` binding instead.                                                        |
| Ordinary Linux shell                      | **Not provided** — This adapter provides the standard file tools plus a model-facing `code` tool, not shell command execution.       |

Import the generated helpers from your project adapter file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';
```

## Choose this adapter when

Use Cloudflare Shell when files must be stored in a durable Workspace and agent work can be expressed through Workspace operations. It is not interchangeable with a container: `harness.sandbox.exec(...)` does not provide Linux command execution through this adapter — it throws. Use the file verbs on `harness.sandbox` for durable file access, or narrow to the native `Workspace` with `shellWorkspace(harness.sandbox)` for operations the generic surface doesn't cover.

If the workspace should survive later user interactions, associate it with a stable agent instance id. A workspace keyed to a throwaway id belongs to that id's owner rather than forming a shared workspace.

See [Sandboxes](/docs/guide/sandboxes/) and [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/).
