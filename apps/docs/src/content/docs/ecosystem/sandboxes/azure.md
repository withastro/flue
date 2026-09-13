---
title: Azure Sandboxes
description: Connect a Flue agent to an application-owned Azure Container Apps sandbox.
lastReviewedAt: 2026-09-13
---

The Azure adapter connects a Node-hosted Flue application to an existing
[Azure Container Apps Sandbox](https://sandboxes.azure.com/docs/sandboxes/).
The application owns the sandbox group, authentication, sandbox identity,
and lifecycle. Azure Sandboxes and the SDK used here are in preview.

## Quickstart

```bash
flue add sandbox azure
```

The blueprint installs `@azure/containerapps-sandbox@1.0.0-beta.1` and
`@azure/identity`, and writes `sandboxes/azure.ts` in your source root. It
wraps a `SandboxGroupClient` and sandbox ID using Flue's existing
`SandboxDriver` contract.

Follow the [Azure TypeScript quickstart](https://sandboxes.azure.com/docs/sandboxes/quickstart/setup-typescript-sdk)
to provision a sandbox group, grant your identity data-plane access, and
create a sandbox. Start with the Ubuntu image. Ensure it has `sh`, `env`,
`base64`, `mkdir`, and GNU `timeout`, and create `/workspace` before running
the example below.

## Configure

| Setting                 | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the sandbox group.     |
| `AZURE_RESOURCE_GROUP`  | Resource group containing the sandbox group.   |
| `AZURE_SANDBOX_GROUP`   | Sandbox group name.                            |
| `AZURE_REGION`          | Region used to select the data-plane endpoint. |
| `AZURE_SANDBOX_ID`      | Existing, running sandbox to attach.           |

Locally, run `az login` so `DefaultAzureCredential` can use your Azure CLI
identity. In Azure, configure a managed identity with data-plane access to
the sandbox group. The Azure quickstart uses the
`Container Apps SandboxGroup Data Owner` role scoped to that group.

`flue run` loads `.env`; `vite dev` and built servers read the shell
environment. Follow your application's secret conventions for deployed
credentials.

## Typical use

```ts
'use agent';
import { SandboxGroupClient, endpointForRegion } from '@azure/containerapps-sandbox';
import { DefaultAzureCredential } from '@azure/identity';
import { useModel, useSandbox } from '@flue/runtime';
import { azure } from '../sandboxes/azure';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSandbox(options) {
      const client = new SandboxGroupClient(
        new DefaultAzureCredential(),
        endpointForRegion(process.env.AZURE_REGION!),
        process.env.AZURE_SUBSCRIPTION_ID!,
        process.env.AZURE_RESOURCE_GROUP!,
        process.env.AZURE_SANDBOX_GROUP!,
      );
      return azure(client, process.env.AZURE_SANDBOX_ID!, {
        cwd: '/workspace',
      }).createSandbox(options);
    },
  });
  return 'You are a helpful assistant with an Azure Linux sandbox.';
}
```

This example uses one application-owned workspace. For per-agent
workspaces, persist a mapping from the `id` passed to `createSandbox` to an
Azure sandbox ID, coordinate concurrent creation, and reconnect on later
initializations. Do not share one sandbox between unrelated tenants.

Resume stopped sandboxes before attaching them. Configure idle policies to
allow active work, and suspend or delete resources when your application
is finished with them. The adapter does not automatically provision,
resume, or destroy sandboxes. Azure filesystem persistence is separate
from Flue's durable conversation storage.

## Behavior and limitations

The adapter supports file reads/writes, metadata, directory listing,
existence checks, directory creation, deletion, and shell execution. It
preserves stdout, stderr, and exit status. Relative paths resolve against
the configured working directory; writes create missing parents.

Binary reads use base64 over the shell API because the preview SDK's file
read path can corrupt non-UTF-8 bytes. Reads buffer the entire file and
remain subject to command-output limits; use a separate transfer mechanism
for large artifacts. Metadata exposes file/directory classification and
available size and modification time, but no symlink flag.

Recursive directory creation uses `mkdir -p`. Recursive removal uses the
SDK; `rm({ force: true })` is rejected before deletion.

The SDK has no native command environment or process deadline fields. The
adapter safely quotes environment values and applies `timeoutMs` through
GNU `timeout` inside the sandbox. Timeout normally returns exit code 124;
a TERM-ignoring process is killed after a one-second grace period and may
return 137. Without a deadline, commands are unbounded.

Caller cancellation rejects promptly, but the remote command may still
run. Failed calls check sandbox state and report confirmed sandbox loss as
`SandboxDiedError`. There is no background liveness polling: if the SDK
never settles a request after sandbox loss, an exec caller must abort its
wait. Cloudflare Workers compatibility has not been established.

See [Sandboxes](/docs/guide/sandboxes/),
[Sandbox Adapter API](/docs/reference/sandbox-api/), and
[Azure lifecycle guidance](https://sandboxes.azure.com/docs/sandboxes/sandbox/lifecycle).
