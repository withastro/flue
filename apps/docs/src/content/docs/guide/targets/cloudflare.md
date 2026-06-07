---
title: Cloudflare Target
description: Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
---

The Cloudflare target builds a Worker backed by generated Durable Objects. Use it when your application needs Workers, Durable Objects, Workers AI, Cloudflare AI Gateway, native Agents SDK lifecycle hooks, or Cloudflare-owned sandbox integrations. For setup and deployment, see [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/).

## Runtime model

Flue generates one Durable Object class for each addressable agent and workflow, plus `FlueRegistry` for cross-deployment run lookup. Generated bindings use `FLUE_<NAME>_AGENT`, `FLUE_<NAME>_WORKFLOW`, and `FLUE_REGISTRY`; generated classes use `Flue<Name>Agent`, `Flue<Name>Workflow`, and `FlueRegistry`.

Your project owns Durable Object migration history in project-root `wrangler.jsonc`. Flue generates classes and bindings, but does not append migrations for you. Add a new `new_sqlite_classes` entry whenever you add a generated agent or workflow class, and use Cloudflare rename migrations when changing an already deployed class name.

Cloudflare workflow runs are backed by their owning workflow Durable Object. Agent session state is backed by the owning agent Durable Object. Direct and dispatched agent work use durable admission, and interrupted Cloudflare work uses the Agents SDK fiber model. A recovered workflow is recorded as failed; start a new workflow explicitly if retry is appropriate.

## Workers AI and AI Gateway

The Cloudflare target registers the `cloudflare/...` model prefix against `env.AI`. A model such as `cloudflare/@cf/meta/llama-3.1-8b-instruct` uses the Workers AI binding instead of an HTTP provider credential.

Cloudflare AI Gateway is enabled by default for the generated `cloudflare` provider with `gateway: { id: 'default' }`. Re-register the provider in `app.ts` when you need a named gateway, custom gateway options, or `gateway: false`. See [Cloudflare Workers AI](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) for setup and gateway examples.

The public Cloudflare-specific provider types are `CloudflareAIBinding`, `CloudflareAIBindingRegistration`, and `CloudflareGatewayOptions` from `@flue/runtime/cloudflare`. See [Provider API](/docs/api/provider-api/#cloudflare-binding-registrations) for the registration shape.

## Generated Durable Object extensions

A generated agent or workflow module may export `cloudflare = extend({ base, wrap })` from `@flue/runtime/cloudflare`:

```ts
import { extend } from '@flue/runtime/cloudflare';

export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async onStart() {
        await this.scheduleEvery(60, 'heartbeat');
      }
    },
});
```

`base` receives the Cloudflare Agents SDK `Agent` base class. Flue applies it before defining the final generated Durable Object subclass. `wrap` receives that final generated class and may return a prototype-preserving constructor wrapper such as a Sentry integration. Use this for native SDK lifecycle hooks and instrumentation; do not override Flue-owned `fetch()`, `onRequest()`, WebSocket hooks, `onFiberRecovered()`, or `alarm()` methods.

This module-local extension is separate from source-root `cloudflare.ts`, whose named exports become top-level Worker exports and whose default export may contribute non-HTTP Worker handlers.

## Cloudflare-specific APIs

`@flue/runtime/cloudflare` has a small author-facing surface plus generated-runtime plumbing:

| API | Use |
| --- | --- |
| `extend(...)` | Add a native Agents SDK base class or final-class wrapper to a generated agent or workflow Durable Object. |
| `CloudflareExtension`, `ExtensionClass`, `ResolvedCloudflareExtension` | Types for authored Cloudflare extension descriptors and generated extension resolution. |
| `CloudflareAIBinding`, `CloudflareAIBindingRegistration`, `CloudflareGatewayOptions` | Types for Workers AI binding providers and AI Gateway options. |
| `getCloudflareContext()` | Read the current Worker or Durable Object context inside an advanced application-owned integration. |
| `getDurableObjectIdentity()` | Read the generated binding/class/name/id identity inside a generated Durable Object context. |
| `getVirtualSandbox()` | Removed compatibility stub. Omit `sandbox` for the default in-memory sandbox, or use a generated Cloudflare Shell connector for a project-owned workspace. |
| `getShellSandbox()`, `getDefaultWorkspace()`, `hydrateFromBucket()` | Removed compatibility stubs. Import the generated Cloudflare Shell connector helpers instead. |

`getCloudflareContext()` is only valid while handling Cloudflare runtime work. `getDurableObjectIdentity()` is only valid inside a generated Durable Object context. The context includes the current `env`, the active generated Durable Object instance, SQLite storage, and, when available, the generated binding/class/name/id identity.

The remaining exports, such as `cfSandboxToSessionEnv`, `runWithCloudflareContext`, `createCloudflareRunRegistry`, `FlueRegistry`, `store()`, `getCloudflareAIBindingApiProvider()`, and Cloudflare WebSocket transport helpers, are generated-runtime plumbing or connector infrastructure rather than ordinary application APIs.

## Cloudflare sandboxes and Worker exports

The default Flue sandbox remains an in-memory virtual filesystem. Cloudflare Shell and other Cloudflare-owned sandbox integrations are project-owned connectors. Run `flue add @cloudflare/shell`, then import generated helpers from `connectors/cloudflare-shell` instead of `@flue/runtime/cloudflare`.

Use source-root `cloudflare.ts` for application-owned Durable Objects and non-HTTP Worker handlers. Use `app.ts` for custom HTTP routing and middleware. `cloudflare.ts` must not define a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

## When to use Cloudflare

Choose Cloudflare when you need globally routed Workers, durable agent and workflow ownership, Workers AI, AI Gateway, native Agents SDK lifecycle hooks, or Cloudflare-owned sandbox infrastructure. Use [Node.js](/docs/guide/targets/node/) when you need direct host filesystem access, local shell execution, or an ordinary long-running server process.
