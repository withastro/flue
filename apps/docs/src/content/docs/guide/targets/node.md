---
title: Node.js
description: Understand the Node.js-specific runtime behavior and APIs for Flue applications.
---

The Node.js target builds your agents and workflows as a standard Node.js server. The generated server runs anywhere Node runs: a local machine, a container, a VM, a CI runner, or a managed hosting service. Node is also the target where agents can operate directly on the host filesystem and shell through `local()`.

For a deployment walkthrough, see [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

## Generated server

Flue discovers agents from `src/agents/` and workflows from `src/workflows/` and generates a single server entry at `dist/server.mjs`. See [Project Layout](/docs/guide/project-layout/) for supported source directories.

The server owns HTTP, agent dispatch, workflow admission, and event streaming routes. Build and start it with:

```bash
npx flue build --target node
node dist/server.mjs
```

The server listens on port `3000` by default. Set `PORT` to change it. `flue dev --target node` uses port `3583` and reloads on changes.

The build externalizes your application dependencies rather than bundling them. Deploy the built artifact alongside its `node_modules`, or package it inside a container that installs dependencies first.

## State and durability

Without `db.ts`, the generated Node server uses process-local in-memory SQLite for agent sessions, accepted submissions, and workflow-run records and indexing. This gives one running process ordered state handling, but a restart loses that state.

With a durable adapter, direct prompts and `dispatch(...)` inputs enter the same SQL-backed per-instance queue. Inputs for one agent instance are processed in accepted order.

Node does not get Cloudflare's automatic Durable Object wake or Fiber recovery. A replacement process must start successfully before startup reconciliation runs, and the coordinator periodically scans expired leases so work stranded by a fast restart is eventually reclaimed.

That reconciliation covers agent submissions only. Node currently has no recovery path that terminalizes a workflow run interrupted by a crash or closes its event stream. With a durable adapter the run record and its events survive the restart, but the interrupted run remains listed as `active` and the orphaned `runs/<id>` stream persists in an open state, so live Durable Streams readers — long-poll, SSE, or `flue logs -f` — wait indefinitely for events that will never arrive. Use a catch-up read such as `flue logs --no-follow` to inspect events persisted before the crash. On Cloudflare, Fiber recovery terminalizes interrupted runs and closes their streams.

See [Database](/docs/guide/database/) for `db.ts`, SQLite, Postgres, and custom adapters. See [Durable Agents](/docs/concepts/durable-execution/) for recovery behavior.

## `local()` sandbox

Node is the only target with the built-in `local()` sandbox factory. It gives an agent direct access to the host filesystem and shell, making it useful for development tools, CI tasks, coding agents, and self-hosted automation where the host environment already provides isolation.

```ts title="src/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
}));
```

`local()` uses `process.cwd()` as the working directory by default. Shell commands run through the host shell via `child_process`, and file operations read and write the real filesystem.

Only shell-essential environment variables are exposed to the agent's shell by default. API keys, tokens, and credentials are deliberately excluded. Pass specific values through `env` when a command needs them:

```ts title="src/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local({
    env: { GH_TOKEN: process.env.GH_TOKEN },
  }),
}));
```

Passing `env: { ...process.env }` exposes the full host environment to the model's shell. Do this only in trusted environments.

## Remote sandboxes

When agent work needs per-session isolation, a Linux toolchain, or a provider-managed environment, use a remote sandbox adapter instead of `local()`. Remote sandboxes run on external infrastructure and connect through the [Sandbox Adapter API](/docs/api/sandbox-api/).

See the Ecosystem [Sandboxes](/docs/ecosystem/#sandboxes) catalog for available integrations, including [Daytona](/docs/ecosystem/sandboxes/daytona/), [E2B](/docs/ecosystem/sandboxes/e2b/), and [Modal](/docs/ecosystem/sandboxes/modal/).

## Environment and secrets

Flue CLI commands load project-root `.env` values before configuration. Use `--env <path>` to select one alternate file.

The built server itself does not load `.env`. It reads only the environment supplied when it starts:

```bash
# Development
npx flue dev --target node

# Production
set -a; source .env; set +a
node dist/server.mjs
```

Use the environment variable name your provider expects, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Do not commit `.env` files.

## Reference

### `local(...)`

```ts
import { local } from '@flue/runtime/node';

function local(options?: LocalSandboxOptions): SandboxFactory;
```

Creates a sandbox factory that binds directly to the host filesystem and shell. Pass it to `createAgent(...)` through the `sandbox` option.

**`LocalSandboxOptions`:**

- `cwd` — working directory. Defaults to `process.cwd()`.
- `env` — additional environment variables layered on top of the default shell-essential allowlist. Set a key to `undefined` to remove a default. Per-exec `env` in shell calls layers on top of this.

The environment snapshot is taken once at sandbox construction. Later mutations to `process.env` are not reflected.

### `sqlite(...)`

```ts
import { sqlite } from '@flue/runtime/node';

function sqlite(path?: string): PersistenceAdapter;
```

Creates the built-in Node SQLite persistence adapter. Omit `path` for in-memory storage, or pass a file path for persistence across process restarts.
