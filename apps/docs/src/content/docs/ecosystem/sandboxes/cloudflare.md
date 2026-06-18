---
title: Cloudflare Sandbox
description: Run Flue agent work inside Cloudflare container-backed sandboxes.
---

Cloudflare Sandbox uses `@cloudflare/sandbox` to provide a container-backed Linux environment to a Flue application deployed on Cloudflare. This integration is platform-native: it is not an adapter module for a Node-target application.

## Quickstart

Add container-backed Linux sandbox capability to an existing Flue project with the [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare
```

## Overview

Cloudflare Sandbox is a Cloudflare target integration rather than a generated adapter. In a Cloudflare-targeted project, the blueprint installs `@cloudflare/sandbox`; a workflow obtains the bound Durable Object with `getSandbox(...)`, wraps it with Flue's `cloudflareSandbox(...)`, and passes that sandbox factory to a created agent.

```ts title="<source-root>/workflows/coding-agent.ts (excerpt)"
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init, id, env, payload }: FlueContext<{ message: string }>) {
  const sandbox = cloudflareSandbox(getSandbox(env.Sandbox, id));
  const agent = createAgent(() => ({ sandbox, model: 'anthropic/claude-opus-4-7' }));
  const harness = await init(agent);
  const session = await harness.session();

  return await session.prompt(payload.message);
}
```

The blueprint also exports `Sandbox` from `<source-root>/cloudflare.ts`, adds its Durable Object binding, a new migration entry, and its container declaration to `wrangler.jsonc`, and creates a project-root `Dockerfile` whose image tag matches the installed package version. The resulting workflow runs agent shell and file operations in the container-backed sandbox identified by the workflow run id. Cloudflare's direct delete API does not expose recursive or force controls, so `cloudflareSandbox()` rejects either option before mutation. A Node-targeted project must migrate to the Cloudflare target before using this integration.

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
import { getSandbox } from '@cloudflare/sandbox';
import { createAgent } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

type Env = { Sandbox: DurableObjectNamespace };

export default createAgent<Env>(({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  cwd: '/workspace',
}));
```

## Choose this integration when

Use Cloudflare Sandbox when an agent on Cloudflare needs git, package installation, native binaries, or other Linux tooling. Prefer Cloudflare Shell instead when a durable workspace with Workspace-oriented operations is sufficient and a Linux toolchain is unnecessary.

Treat network egress, mounted data, credentials, and side effects as application security decisions. See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes) and [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/).
