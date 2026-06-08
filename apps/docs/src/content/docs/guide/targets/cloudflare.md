---
title: Cloudflare Target
description: Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
---

The Cloudflare target builds your agents and workflows for the Cloudflare platform. Generated agents and workflows run inside Durable Objects, using the Agents SDK, Workers AI, Cloudflare Sandbox, Cloudflare Shell, and other Worker primitives where appropriate. Durable Objects give each agent instance its own persistent state, durable execution, and global addressability out of the box.

For a deployment walkthrough, see [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/).

## Generated Durable Objects

Flue generates a Durable Object class and a Wrangler binding for each discovered agent and workflow. Agents are discovered from `src/agents/` and workflows from `src/workflows/` (see [Project Layout](/docs/guide/project-layout/) for supported alternatives):

```txt
src/agents/support-chat.ts   ->  FlueSupportChatAgent
                                 env.FLUE_SUPPORT_CHAT_AGENT

src/workflows/translate.ts   ->  FlueTranslateWorkflow
                                 env.FLUE_TRANSLATE_WORKFLOW
```

The class name is how Cloudflare identifies the Durable Object in migrations. The binding is how your application code accesses the Durable Object namespace at runtime through `env`.

Agent session state, accepted submissions, and workflow run history are stored in the owning Durable Object's SQLite storage automatically. The Cloudflare target does not use `db.ts`; a source-root `db.ts` is rejected at build time.

## `wrangler.jsonc`

Your project's `wrangler.jsonc` at the project root configures your Worker's name, compatibility settings, and Durable Object migrations. Flue reads this file during builds and merges its generated bindings alongside your authored configuration.

Flue generates the Durable Object classes and bindings, but your `wrangler.jsonc` must declare two things:

1. **`nodejs_compat`** in `compatibility_flags`, because Flue's runtime uses Node.js APIs.
2. **Durable Object migrations** that list every generated class. Cloudflare requires an explicit migration whenever a Worker adds, renames, or removes a Durable Object class.

```jsonc
{
  "$schema": "https://workers.cloudflare.com/schema/wrangler.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "FlueRegistry",
        "FlueSupportChatAgent",
        "FlueTranslateWorkflow"
      ]
    }
  ]
}
```

`FlueRegistry` is a Flue-internal Durable Object that indexes workflow runs across the deployment. Always include it in your initial migration.

### Managing migrations

Cloudflare requires an ordered migration history that accounts for every Durable Object class your Worker has ever deployed. When you add a new agent or workflow, append a new migration entry with a unique tag:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueSupportChatAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["FlueTranslateWorkflow"] }
  ]
}
```

Never rewrite or reorder deployed migration entries. Generated agent classes require Durable Object SQLite, so introduce them through `new_sqlite_classes`, not legacy `new_classes`. Use Cloudflare's `renamed_classes` and `deleted_classes` migration fields when changing deployed class names or removing classes.

## Durable agent execution

Cloudflare agents durably admit direct HTTP, SSE, and WebSocket prompts together with `dispatch(...)` inputs. All accepted input for one session enters the same per-session queue, while separate sessions can progress independently.

```txt
direct HTTP, SSE, or WebSocket prompt ─┐
                                       ├→ durable per-session queue → stored session history
dispatch(...) input ───────────────────┘
```

The submitting connection observes the work but does not own it. If a client disconnects after admission, backend work can continue. Flue does not reconstruct the lost transport or replay missed direct-agent stream events.

When a Durable Object resumes after interruption, Flue checks stored input and session history before deciding what to do next. It requeues only when it can prove the input was not applied, recognizes already-completed output, and records an interruption instead of blindly repeating uncertain model or tool work.

For the full recovery model, see [Durable Execution](/docs/guide/durable-execution/).

## Workers AI and AI Gateway

[Workers AI](https://developers.cloudflare.com/workers-ai/) lets you run AI models directly on Cloudflare's infrastructure without managing API keys or external provider accounts. Flue connects to Workers AI automatically on the Cloudflare target, so using a Workers AI model is as simple as specifying the model name:

```ts
export default createAgent(() => ({
  model: 'cloudflare/@cf/meta/llama-3.1-8b-instruct',
}));
```

No API key is needed. Authorization and billing follow the Worker account, including the [Workers AI free tier](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Flue also enables [AI Gateway](https://developers.cloudflare.com/ai-gateway/) by default for all `cloudflare/...` models, giving you caching, request logging, rate limiting, and budget controls in the Cloudflare dashboard out of the box.

To customize the gateway, disable it, or target a named gateway, re-register the `cloudflare` provider in `app.ts`. See [Cloudflare Workers AI](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) for examples.

## Cloudflare Sandbox

[Cloudflare Sandbox](https://developers.cloudflare.com/containers/) provides container-backed Linux environments for agents that need tools such as git, package installation, native binaries, or a real filesystem. Export the sandbox Durable Object class from `cloudflare.ts`, declare its binding and container image in `wrangler.jsonc`, then pass the RPC stub returned by `getSandbox(...)` to `createAgent(...)`:

```ts
import { getSandbox } from '@cloudflare/sandbox';
import { createAgent } from '@flue/runtime';

type Env = { Sandbox: DurableObjectNamespace };

export default createAgent<unknown, Env>(({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: getSandbox(env.Sandbox, id),
  cwd: '/workspace',
}));
```

See [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) for container configuration and lifecycle guidance.

## Codemode

By default, Flue agents use a lightweight in-memory virtual sandbox. This is fast and sufficient for prompt-and-response agents or agents that only need tools and structured results. When an agent needs a durable workspace with structured code execution instead of a full Linux container, use Cloudflare Shell with Codemode.

[Cloudflare Shell](https://developers.cloudflare.com/agents/api-reference/cloudflare-shell/) provides a durable `Workspace` with a model-facing `code` tool backed by [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/api-reference/codemode/). The agent interacts with files through structured code operations rather than shell commands. This means `harness.shell(...)` and `session.shell(...)` do not run arbitrary Linux commands through this connector.

Add the connector to your project:

```bash
pnpm exec flue add cloudflare-shell
```

Then import its helpers from your generated connector file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../connectors/cloudflare-shell';
```

Use Cloudflare Shell when a durable Workspace and structured code operations are enough. Use Cloudflare Sandbox when you need a full Linux environment with arbitrary shell access. See [Cloudflare Shell](/docs/ecosystem/sandboxes/cloudflare-shell/) for setup details.

## Extending Agents and Workflows on Cloudflare

Flue owns each generated Durable Object class. When an agent or workflow needs access to native Cloudflare Agents SDK capabilities such as `onStart()`, `schedule()`, `scheduleEvery()`, or `queue()`, export a `cloudflare` extension descriptor from its module:

```ts
import { createAgent } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
}));

export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async onStart() {
        await this.scheduleEvery(60, 'heartbeat');
      }

      async heartbeat() {
        this.setState({ ...this.state, lastHeartbeatAt: Date.now() });
      }
    },
});
```

`base` receives the Agents SDK `Agent` base class. Flue applies it before defining the final generated Durable Object subclass, so your authored methods and lifecycle hooks are available on the generated class.

`wrap` receives the final generated class and may return a prototype-preserving constructor wrapper. Use it for integrations like Sentry that instrument the class without replacing its prototype:

```ts
export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      (env) => ({ dsn: env.SENTRY_DSN }),
      Final,
    ),
});
```

Both `base` and `wrap` are optional. Do not override Flue-owned `fetch()`, `onRequest()`, WebSocket hooks, `onFiberRecovered()`, or `alarm()` methods.

## Extending `cloudflare.ts` Entrypoint

Your project may include a source-root `cloudflare.ts` file for Worker-level Cloudflare code that is separate from individual agent and workflow modules.

Any **named export** from this file becomes a top-level Worker export. This is how you add application-owned Durable Objects to the same Worker that Flue manages. For example, a cache Durable Object that your agents can access through `env`:

```ts title="src/cloudflare.ts"
import { DurableObject } from 'cloudflare:workers';

// This class becomes a Worker export. Declare its binding and
// migration in wrangler.jsonc so Cloudflare knows about it.
export class SalesforceAuthCache extends DurableObject {
  async refreshIfNeeded() {
    return await this.ctx.storage.get('token');
  }
}
```

After exporting the class, declare its Durable Object binding and migration in `wrangler.jsonc`. Your agents and workflows can then access it through `env.SALESFORCE_AUTH_CACHE`.

The **default export** may contribute non-HTTP Worker handlers. For example, a `scheduled` handler that runs on a cron trigger:

```ts title="src/cloudflare.ts"
export default {
  async scheduled(_controller, env) {
    await env.SALESFORCE_AUTH_CACHE.getByName('default').refreshIfNeeded();
  },
};
```

Use `app.ts` for custom HTTP routes and middleware. `cloudflare.ts` must not define a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

## Reference

### `extend(...)`

```ts
import { extend } from '@flue/runtime/cloudflare';

function extend(extension: CloudflareExtension): CloudflareExtension;
```

Creates a branded Cloudflare extension descriptor for an agent or workflow module. The descriptor may contain `base` and `wrap` callbacks.

`base(Base)` must return the received class or a subclass. Flue uses its return value as the superclass for the generated Durable Object.

`wrap(Final)` must return the received class or a prototype-preserving constructor wrapper. Use it for integrations that instrument or proxy the final generated class without replacing its prototype. Subclasses are rejected; only the same class or a `new Proxy(Final, {...})` pattern is allowed.

Both callbacks are optional. When omitted, the corresponding step is an identity operation.

### `getCloudflareContext()`

```ts
import { getCloudflareContext } from '@flue/runtime/cloudflare';

function getCloudflareContext(): CloudflareContext;
```

Returns the current Cloudflare runtime context. Only valid while code is running inside a Worker or Durable Object request handler.

The returned `CloudflareContext` includes:

- `env` -- the Worker's environment bindings.
- `agentInstance` -- the active generated Durable Object instance, with `state` and `setState(...)`.
- `storage` -- the Durable Object's `{ sql }` SQLite storage handle.

Throws outside of Cloudflare runtime work.

This is intended for advanced application-owned integrations such as custom Cloudflare sandbox connectors. Most applications do not need to call this directly.

### `getDurableObjectIdentity()`

```ts
import { getDurableObjectIdentity } from '@flue/runtime/cloudflare';

function getDurableObjectIdentity(): FlueDurableObjectIdentity;
```

Returns the generated Durable Object identity for the current agent or workflow context. Only valid inside a generated Durable Object request handler.

The returned `FlueDurableObjectIdentity` includes:

- `bindingName` -- the Wrangler binding name, such as `"FLUE_TRANSLATE_WORKFLOW"`.
- `className` -- the generated class name, such as `"FlueTranslateWorkflow"`.
- `name` -- the instance name passed to `idFromName` or `getAgentByName`.
- `id` -- the Durable Object ID as a string.

Throws when called outside a generated Durable Object context.
