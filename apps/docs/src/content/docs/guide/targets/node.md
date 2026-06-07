---
title: Node.js Target
description: Understand the Node.js-specific runtime behavior and APIs for Flue applications.
---

The Node.js target builds a long-running Flue server. Use it when your application runs in an ordinary process, container, VM, CI runner, or managed Node service. For setup and deployment, see [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

## Runtime model

The generated Node server owns HTTP, WebSocket, agent dispatch, workflow admission, and run inspection routes. It uses the same authored agent and workflow modules as every other target, but its built-in state is process-local.

Node keeps workflow run history in memory by default. Agent session history also uses the default in-memory store unless a created agent returns `persist`. Restarting the process clears that state. Use an application-owned `SessionStore` when agent session history must survive process restarts. Workflow run history remains process-local by default.

The generated server listens on port `3000` by default. Set `PORT` to change it. `flue dev --target node` uses port `3583` for local development.

## Host filesystem access

Node is the only target with the built-in `local()` sandbox factory. Import it from `@flue/runtime/node` when an agent should use the host filesystem and shell directly:

```ts
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
}));
```

`local()` uses `process.cwd()` by default. Shell commands run through the host shell, and file operations read and write the real filesystem. This is useful for trusted development tools, CI runners, and self-hosted coding agents. It is not an isolation boundary.

Only shell-essential environment variables are exposed by default. Pass explicit values through `env` when a command needs more:

```ts
const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local({
    env: { GH_TOKEN: process.env.GH_TOKEN },
  }),
}));
```

Passing `env: { ...process.env }` exposes the full host environment to the model's shell tool and should be intentional.

## WebSocket transport

The generated Node server includes WebSocket support for agent and workflow modules that export `websocket` middleware. Agents stay connected for sequential prompts at `GET /agents/:name/:id`; workflows accept one invocation at `GET /workflows/:name` and then close.

## Node-specific APIs

`@flue/runtime/node` has a small public surface:

| API | Use |
| --- | --- |
| `local(options?)` | Create a host-bound sandbox for trusted Node applications. This is the normal authoring API. |
| `LocalSandboxOptions` | Configure `local()` with `cwd` and explicit `env` overrides. |
| `createNodeWebSocketTransport(options)` | Mount Flue's Node WebSocket transport into a custom generated-server integration. Ordinary applications should use exported `websocket` middleware instead. |
| `NodeWebSocketTransport` / `NodeWebSocketTransportOptions` | Types for custom Node transport integrations. |

The WebSocket transport exports are generated-runtime plumbing, not the ordinary application path.

## Build and dependency model

`flue build --target node` emits a generated server into `dist/server.mjs`. It does not bundle your application dependencies. Deploy the built artifact with its required `node_modules`, or package it inside a container or deployment platform that installs dependencies first.

Node supports ordinary `.env` loading during CLI commands. `flue build`, `flue dev`, and `flue run` load project-root `.env` values before configuration. The built server itself reads only the environment supplied when it starts.

## When to use Node

Choose Node when you need host filesystem access, local shell execution, long-lived process memory, ordinary package dependencies, or application-owned persistence outside a platform-specific Durable Object model. Use [Cloudflare](/docs/guide/targets/cloudflare/) when you want Workers, Durable Objects, Workers AI, and Cloudflare's native runtime integrations.
