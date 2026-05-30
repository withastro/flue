---
title: Cloudflare Shell
description: Use a durable Cloudflare Workspace with code-oriented agent operations.
---

The Cloudflare Shell connector adapts an application-owned `@cloudflare/shell` `Workspace` into a Flue sandbox on the Cloudflare target. Unlike a Linux shell sandbox, it provides a durable workspace and a model-facing `code` tool that executes JavaScript against workspace state through a Worker Loader binding.

## Add the connector

```bash
pnpm exec flue add cloudflare-shell
```

Import the generated helpers from your project connector file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../connectors/cloudflare-shell';
```

## Requirements

| Requirement | Value |
| --- | --- |
| Target | Cloudflare |
| Provider packages | `@cloudflare/shell` and `@cloudflare/codemode` |
| Platform configuration | A `worker_loaders` binding such as `LOADER` |
| Model-facing capability | `code` tool operating on Workspace state |
| Ordinary shell | Not provided by this connector |

## Choose this connector when

Use Cloudflare Shell when files must be stored in a durable Workspace and agent work can be expressed through Workspace operations. It is not interchangeable with a container: `harness.shell(...)` and `session.shell(...)` do not provide Linux command execution through this connector.

If the workspace should survive later user interactions, associate it with a stable addressable agent instance. A workspace created inside one workflow invocation belongs to that invocation's owner rather than forming a shared cross-run workspace.

You can hydrate content from R2 through the generated connector helper before initializing the consuming harness. Hydration is a copy into Workspace, not a live-mounted bucket.

See [Sandboxes](/docs/guide/sandboxes/) and [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/).
