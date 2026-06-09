---
title: Sandboxes
description: Give agents a workspace for files and command-driven work.
lastReviewedAt: 2026-05-30
---

Sandboxes give an agent a workspace to read, write, and run commands in while it works. Use them when an agent needs to operate on files or run commands, rather than only respond to prompts or call application-defined [tools](/docs/guide/tools/).

Flue provides a lightweight virtual sandbox by default. Use a local sandbox when a trusted Node.js agent should operate directly on its host machine, or a remote sandbox when work needs an isolated environment with its own tooling and lifecycle.

## Virtual sandbox

By default, an initialized agent works in a virtual sandbox unless you configure another environment. The virtual sandbox is a lightweight, in-memory workspace powered by [just-bash](https://justbash.dev/). It is the right starting point when your application can provide the files the agent needs.

For example, a workflow can stage an input document, let an agent work on it, and retrieve an output file:

```ts title="src/workflows/review-document.ts"
import { createAgent, type FlueContext } from '@flue/runtime';

const reviewer = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  cwd: '/workspace',
}));

export async function run({ init, payload }: FlueContext<{ document: string }>) {
  const harness = await init(reviewer);
  await harness.fs.writeFile('document.md', payload.document);

  const session = await harness.session();
  await session.prompt('Review document.md and write your findings to review.md.');

  return { review: await harness.fs.readFile('review.md') };
}
```

No `sandbox` field is needed here: omitting it selects the virtual sandbox. `cwd` sets the working directory, so these relative file paths resolve below `/workspace`. The agent can use built-in file and command capabilities in that workspace, while application code uses `harness.fs` to provide inputs and retrieve results.

The virtual sandbox starts without your application files or host filesystem, and its files do not persist beyond its in-memory lifetime. Its command environment is suitable for lightweight workspace work, not an arbitrary Linux toolchain. It is also not a network isolation boundary: current generated runtimes permit network access from the virtual sandbox.

## Local sandbox

On the Node.js target, use `local()` when an agent should operate directly on the host filesystem and shell. This is useful for trusted development tools or disposable CI runners working against an existing checkout:

```ts title="src/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local(),
  cwd: '/srv/checkouts/catalog-service',
  instructions: 'Inspect the requested change and run only relevant validation.',
}));
```

`local()` makes host files and installed commands reachable through the agent's workspace capabilities. It does not provide isolation between model-directed work and the host machine.

Host environment variables are deliberately limited by default. If a command requires an additional value, expose it explicitly through `local({ env: { ... } })`. Avoid giving a model-directed shell broad credentials when a narrow application [tool](/docs/guide/tools/) can perform the required action instead.

Use `local()` only where the host and input are already trusted for this level of access. Do not use it as an isolation boundary for untrusted requests or multiple tenants.

## Remote sandboxes

Use a remote sandbox when agent work needs an environment that should not run on the application host: for example, untrusted or tenant-specific tasks, coding work that requires a Linux toolchain, or workspaces that need provider-managed lifetime and storage.

A remote sandbox is supplied through an integration appropriate to the provider or platform. Your application is responsible for deciding which workspace belongs to which agent instance or workflow, what credentials and network access it receives, whether it may be reused, and when it is deleted or expired.

See the Ecosystem **Sandboxes** integrations, such as [Daytona](/docs/ecosystem/sandboxes/daytona/), to connect a provider-managed remote sandbox. If you need to implement an integration, see the [Sandbox Connector API](/docs/api/sandbox-api/).

Cloudflare deployments can use [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) for a native container-backed Linux sandbox. Use it when an agent deployed on Cloudflare needs tools such as git, package installation, or native commands; its setup and lifecycle details belong in the integration guide.

A sandbox integration may expose different model-facing capabilities than the virtual and local sandboxes. Check the integration documentation before assuming ordinary file or command tools are available.

## Persistence and security

The sandbox controls workspace and command access. It does not determine whether a session retains conversation history. Keep these decisions separate:

| Decision                                                            | Controlled by                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Conversation history available in a later session interaction       | Session persistence via `db.ts` adapter or the target default.        |
| Files, installed packages, and generated artifacts available later  | The sandbox or workspace lifecycle you choose.                        |
| Access to repositories, APIs, credentials, and network destinations | The sandbox environment, tools, and application authorization policy. |

A persisted session does not make the virtual sandbox durable. Likewise, a durable remote workspace does not by itself preserve a session conversation.

Choose the narrowest sandbox that supports the task. Expanding the environment expands what model-directed work can read, change, execute, and reach.

## Next steps

- [Agents](/docs/guide/building-agents/) — configure continuing agents that work inside a sandbox.
- [Workflows](/docs/guide/workflows/) — stage files and collect artifacts during finite work.
- [Tools](/docs/guide/tools/) — expose bounded application actions separately from workspace access.
- [Skills](/docs/guide/skills/) — bundle procedures or provide workspace-discovered skills.
- [Sandbox Connector API](/docs/api/sandbox-api/) — implement a provider-backed sandbox integration.
- [Daytona](/docs/ecosystem/sandboxes/daytona/) and [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) — configure remote sandbox integrations.
