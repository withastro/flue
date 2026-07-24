---
title: Cloudflare Sandbox
description: Run Flue agent work inside Cloudflare container-backed sandboxes.
lastReviewedAt: 2026-07-21
---

Cloudflare Sandbox uses `@cloudflare/sandbox` to provide a container-backed Linux environment to a Flue application deployed on Cloudflare. This integration is platform-native: it is not an adapter module for a Node-target application.

## Quickstart

Add container-backed Linux sandbox capability to an existing Flue project with the [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare
```

## Overview

Cloudflare Sandbox is a Cloudflare target integration rather than a generated adapter. In a Cloudflare-targeted project, the blueprint installs `@cloudflare/sandbox`; the agent function obtains the bound Durable Object with `getSandbox(...)`, wraps it with Flue's `cloudflareSandbox(...)`, and attaches it with `useSandbox(...)`.

```ts title="src/agents/coding-agent.ts (excerpt)"
'use agent';
import { env } from 'cloudflare:workers';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace;
}

export function CodingAgent({ id }: AgentProps) {
  useModel('anthropic/claude-opus-4-7');
  const { Sandbox } = env as unknown as Env;
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)));
}
```

The blueprint also exports `Sandbox` from the source-root `cloudflare.ts`, adds its Durable Object binding, a new migration entry, and its container declaration to `wrangler.jsonc`, and creates a project-root `Dockerfile` whose image tag matches the installed package version. Agent shell and file operations run in the container-backed sandbox keyed by the agent instance id. Cloudflare's direct delete API does not expose recursive or force controls, so `cloudflareSandbox()` implements either option by running `rm` in the container, matching Node's `fs.rm` semantics. A Node-targeted project must migrate to the Cloudflare target before using this integration.

## Configure

| Requirement                                  | Purpose                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare target                            | **Required** — Runs the platform-native sandbox integration.                                                                 |
| `@cloudflare/sandbox` package                | **Required** — Provides the Sandbox Durable Object and RPC client.                                                           |
| Container image                              | **Required** — Defines the Linux filesystem and command environment.                                                         |
| Durable Object/container binding             | **Required on Cloudflare** — Exposes the sandbox through Wrangler platform configuration; it is not an environment variable. |
| Stable sandbox identity and retention policy | **Required** — Controls lifecycle and reuse for the application.                                                             |
| Environment-variable credentials             | **Not required** — The platform integration uses Cloudflare bindings and deployment configuration instead.                   |

Cloudflare Sandbox requires a Worker deployment, Durable Object/container configuration, and a container image. Add the dependency to a Cloudflare-targeted project and export its Durable Object class from your Cloudflare deployment module:

```ts
// <source-root>/cloudflare.ts
export { Sandbox } from '@cloudflare/sandbox';
```

Declare the sandbox binding in Wrangler configuration, then wrap the RPC stub returned by `getSandbox(...)` with `cloudflareSandbox(...)` and pass it to an agent:

```ts
import { env } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

interface Env {
  Sandbox: DurableObjectNamespace;
}

export function Assistant({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  const { Sandbox } = env as unknown as Env;
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)), { cwd: '/workspace' });
}
```

## Choose this integration when

Use Cloudflare Sandbox when an agent on Cloudflare needs git, package installation, native binaries, or other Linux tooling. Prefer Cloudflare Shell instead when a durable workspace with Workspace-oriented operations is sufficient and a Linux toolchain is unnecessary.

Treat network egress, mounted data, credentials, and side effects as application security decisions. See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes) and [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/).
