---
title: Cloudflare Target
description: Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
---

The Cloudflare target builds your agents and workflows for Cloudflare Workers. Generated agents and workflows run inside Durable Objects, using the Agents SDK, Workers AI, Cloudflare Sandbox, Cloudflare Shell, and other Worker primitives where appropriate.

For a deployment walkthrough, see [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/).

## Generated Durable Objects

Flue generates a Durable Object class and a Wrangler binding for each discovered agent and workflow. Agents are discovered from `src/agents/` and workflows from `src/workflows/`; see [Project Layout](/docs/guide/project-layout/) for supported source directories.

```txt
src/agents/support-chat.ts   ->  FlueSupportChatAgent
                                 env.FLUE_SUPPORT_CHAT_AGENT

src/workflows/translate.ts   ->  FlueTranslateWorkflow
                                 env.FLUE_TRANSLATE_WORKFLOW
```

The class name is how Cloudflare identifies the Durable Object in migrations. The binding is how your application code accesses the Durable Object namespace through `env`.

Agent session state, accepted submissions, and workflow run history are stored in Durable Object SQLite automatically. The Cloudflare target does not use `db.ts`; a source-root `db.ts` is rejected at build time.

## `wrangler.jsonc`

Your project-root `wrangler.jsonc` configures the Worker's name, compatibility settings, and Durable Object migrations. Flue reads this file during builds and merges its generated bindings alongside your authored configuration.

Flue generates the Durable Object classes and bindings, but your `wrangler.jsonc` must declare:

1. `nodejs_compat` in `compatibility_flags`, because Flue's runtime uses Node.js APIs.
2. Durable Object migrations that list every generated class.

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

`FlueRegistry` is a Flue-internal Durable Object that indexes workflow runs across the deployment. Keep deployed migration entries in order. When adding a new agent or workflow, append a new migration entry with a unique tag. Generated agent classes require Durable Object SQLite, so introduce them through `new_sqlite_classes`, not legacy `new_classes`.

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

[Workers AI](https://developers.cloudflare.com/workers-ai/) lets you run models directly on Cloudflare infrastructure without managing API keys or external provider accounts. Flue connects to Workers AI automatically on the Cloudflare target, so using a Workers AI model is as simple as specifying the model name:

```ts
export default createAgent(() => ({
  model: 'cloudflare/@cf/meta/llama-3.1-8b-instruct',
}));
```

No API key is needed. Authorization and billing follow the Worker account.

Flue also enables [AI Gateway](https://developers.cloudflare.com/ai-gateway/) by default for `cloudflare/...` models. To customize the gateway, disable it, or target a named gateway, re-register the `cloudflare` provider in `app.ts`. See [Cloudflare Workers AI](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) for examples.

## Cloudflare Sandbox and Shell

[Cloudflare Sandbox](https://developers.cloudflare.com/containers/) provides container-backed Linux environments for agents that need tools such as git, package installation, native binaries, or a real filesystem. Export the sandbox Durable Object class from `cloudflare.ts`, declare its binding and container image in `wrangler.jsonc`, then pass the RPC stub returned by `getSandbox(...)` to `createAgent(...)`.

[Cloudflare Shell](https://developers.cloudflare.com/agents/api-reference/cloudflare-shell/) provides a durable `Workspace` with a model-facing `code` tool backed by Codemode. Use it when a durable workspace and structured code operations are enough. Use Cloudflare Sandbox when you need a full Linux environment with arbitrary shell access.

See [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) and [Cloudflare Shell](/docs/ecosystem/sandboxes/cloudflare-shell/) for setup details.

## Extending generated Durable Objects

Flue owns each generated agent and workflow Durable Object class. When an addressable agent or workflow needs native Cloudflare Agents SDK capabilities such as `onStart()`, `schedule()`, `scheduleEvery()`, or `queue()`, export a `cloudflare` extension descriptor from its module:

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

`base` receives the Agents SDK base class. Flue applies it before defining the final generated Durable Object subclass. `wrap` receives the final generated class and may return a prototype-preserving wrapper for integrations such as Sentry.

Do not override `fetch()`, `onRequest()`, WebSocket hooks, `onFiberRecovered()`, or `alarm()`: Flue and the Agents SDK use those methods for routing, hibernating connections, interruption recovery, and alarm multiplexing.

## Extending `cloudflare.ts`

Your project may include a source-root `cloudflare.ts` file for Worker-level Cloudflare code that is separate from individual agent and workflow modules.

Named exports from this file become top-level Worker exports. This is how you add application-owned Durable Objects to the same Worker that Flue manages:

```ts title="src/cloudflare.ts"
import { DurableObject } from 'cloudflare:workers';

export class SalesforceAuthCache extends DurableObject {
  async refreshIfNeeded() {
    return await this.ctx.storage.get('token');
  }
}
```

The default export may contribute non-HTTP Worker handlers, such as `scheduled`. Use `app.ts` for custom HTTP routes and middleware. `cloudflare.ts` must not define a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

## Reference

### `extend(...)`

```ts
import { extend } from '@flue/runtime/cloudflare';

function extend(extension: CloudflareAgentExtension): CloudflareAgentExtension;
```

Creates a branded Cloudflare extension descriptor for an agent or workflow module. The descriptor may contain `base` and `wrap` callbacks.

### `getCloudflareContext()`

```ts
import { getCloudflareContext } from '@flue/runtime/cloudflare';

function getCloudflareContext(): CloudflareContext;
```

Returns the current Cloudflare runtime context. Only valid while code is running inside a Worker or Durable Object request handler.

### `getDurableObjectIdentity()`

```ts
import { getDurableObjectIdentity } from '@flue/runtime/cloudflare';

function getDurableObjectIdentity(): FlueDurableObjectIdentity;
```

Returns the generated Durable Object identity for the current agent or workflow context. Only valid inside a generated Durable Object request handler.
