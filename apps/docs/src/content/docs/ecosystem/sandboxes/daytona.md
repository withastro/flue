---
title: Daytona
description: Connect a Flue agent to an application-owned Daytona sandbox.
---

The Daytona connector adapts an already-initialized Daytona sandbox from `@daytona/sdk` into Flue's `SandboxFactory` interface. Use it when a Node-hosted application needs a provider-managed sandbox with filesystem and shell operations.

## Add the connector

```bash
pnpm exec flue add daytona
```

The repository includes a runnable integration shape in `examples/hello-world/.flue/connectors/daytona.ts`.

## Requirements

| Requirement | Value |
| --- | --- |
| Provider package | `@daytona/sdk` |
| Credential | `DAYTONA_API_KEY` |
| Integration shape | Your code creates a Daytona sandbox, then passes it through `daytona(sandbox)` |
| Lifecycle ownership | Your application owns creation, retention, and deletion |

## Typical use

```ts
import { Daytona } from '@daytona/sdk';
import { createAgent } from '@flue/runtime';
import { daytona } from '../connectors/daytona';

const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
const sandbox = await client.create();
const agent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: daytona(sandbox),
  cwd: '/workspace',
}));
```

Delete an ephemeral sandbox in application code after bounded work completes. If a continuing agent instance should reuse a remote workspace, map instance identity to sandbox identity and implement retention and cleanup deliberately.

See [Sandboxes](/docs/guide/sandboxes/#remote-sandboxes) and [Sandbox Connector API](/docs/api/sandbox-api/).
