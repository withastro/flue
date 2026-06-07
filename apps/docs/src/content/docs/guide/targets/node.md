---
title: Node.js Target
description: Understand the Node.js-specific runtime behavior and APIs for Flue applications.
---

The Node.js target builds your agents and workflows as a standard Node.js server. The generated server runs anywhere Node runs: a local machine, a container, a VM, a CI runner, or a managed hosting service. Node is the only target where agents can operate directly on the host filesystem and shell.

For a deployment walkthrough, see [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

## Generated Server

Flue discovers agents from `src/agents/` and workflows from `src/workflows/` (see [Project Layout](/docs/guide/project-layout/) for supported alternatives) and generates a single server entry at `dist/server.mjs`.

The server owns HTTP, WebSocket, agent dispatch, workflow admission, and run inspection routes. Build and start it with:

```bash
npx flue build --target node
node dist/server.mjs
```

The server listens on port `3000` by default. Set `PORT` to change it. `flue dev --target node` uses port `3583` and reloads on changes.

The build externalizes your application dependencies rather than bundling them. Deploy the built artifact alongside its `node_modules`, or package it inside a container that installs dependencies first.

## State and Persistence

On the Node target, all built-in state is process-local. Workflow run history and agent session history live in memory by default. Restarting the process clears both.

For agents that need session history to survive process restarts, return a `SessionStore` from `createAgent(...)` through the `persist` option. A store implements three methods operating on a session ID and a complete `SessionData` record:

```ts title="src/agents/support-assistant.ts"
import { createAgent, type SessionStore, type SessionData } from '@flue/runtime';

const store: SessionStore = {
  async save(id: string, data: SessionData) { /* write to DB */ },
  async load(id: string) { /* read from DB, return null if not found */ },
  async delete(id: string) { /* delete from DB */ },
};

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  persist: store,
}));
```

You can back a `SessionStore` with any database: SQLite, Postgres, Redis, or anything else your application owns. See the [Data Persistence API](/docs/api/data-persistence-api/) for the full `SessionStore` and `SessionData` contracts.

Workflow run history remains process-local by default and is not currently configurable through an application-owned store on the Node target.

## `local()` Sandbox

Node is the only target with the built-in `local()` sandbox factory. It gives an agent direct access to the host filesystem and shell, making it ideal for development tools, CI tasks, coding agents, and self-hosted automation where the host environment already provides isolation.

```ts title="src/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
}));
```

`local()` uses `process.cwd()` as the working directory by default. Shell commands run through the host shell via `child_process`, and file operations read and write the real filesystem.

### Environment variable safety

Only shell-essential environment variables are exposed to the agent's shell by default: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, `TERM`, `TMPDIR`, and a few others. API keys, tokens, and credentials are deliberately excluded.

Pass specific values through `env` when a command needs them:

```ts
const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local({
    env: { GH_TOKEN: process.env.GH_TOKEN },
  }),
}));
```

Passing `env: { ...process.env }` exposes the full host environment to the model's shell tool. This should be intentional and limited to trusted environments.

### Custom working directory

Pass `cwd` to set the agent's working directory to a specific path instead of `process.cwd()`:

```ts
const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local({ cwd: '/srv/repositories/catalog-service' }),
}));
```

A created agent's `cwd` field is resolved relative to the `local()` working directory, so `local({ cwd: '/srv/repos' })` with `cwd: 'catalog'` resolves to `/srv/repos/catalog`.

## Remote Sandboxes

When agent work needs per-session isolation, a Linux toolchain, or a provider-managed environment, use a remote sandbox connector instead of `local()`. Remote sandboxes run on external infrastructure and connect through the [Sandbox Connector API](/docs/api/sandbox-api/).

See the Ecosystem [Sandboxes](/docs/ecosystem/overview/) catalog for available integrations, including [Daytona](/docs/ecosystem/sandboxes/daytona/), [E2B](/docs/ecosystem/sandboxes/e2b/), and [Modal](/docs/ecosystem/sandboxes/modal/).

## Environment and Secrets

Flue CLI commands (`flue build`, `flue dev`, `flue run`, `flue connect`) load project-root `.env` values before configuration. Use `--env <path>` to select an alternate file.

The built server itself does not load `.env`. It reads only the environment supplied when it starts:

```bash
# Development (loads .env automatically)
npx flue dev --target node

# Production (supply env yourself)
set -a; source .env; set +a
node dist/server.mjs
```

Use the environment variable name your provider expects: `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. Do not commit `.env` files.

## Reference

### `local(...)`

```ts
import { local } from '@flue/runtime/node';

function local(options?: LocalSandboxOptions): SandboxFactory;
```

Creates a sandbox factory that binds directly to the host filesystem and shell. Pass it to `createAgent(...)` through the `sandbox` option.

**`LocalSandboxOptions`:**

- `cwd` -- working directory. Defaults to `process.cwd()`.
- `env` -- additional environment variables layered on top of the default shell-essential allowlist. Set a key to `undefined` to remove a default. Per-exec `env` in shell calls layers on top of this.

The environment snapshot is taken once at sandbox construction. Later mutations to `process.env` are not reflected.

### `createNodeWebSocketTransport(...)`

```ts
import { createNodeWebSocketTransport } from '@flue/runtime/node';

function createNodeWebSocketTransport(
  options: NodeWebSocketTransportOptions,
): NodeWebSocketTransport;
```

Creates Flue's Node WebSocket transport for agent and workflow connections. This is generated-runtime plumbing used by the generated server entry. Ordinary applications should export `websocket` middleware from their agent and workflow modules instead of calling this directly.
