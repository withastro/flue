---
title: Cloudflare
description: Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
lastReviewedAt: 2026-07-21
---

The Cloudflare target builds your agents for the Cloudflare platform. Each agent runs inside its own Durable Object class, using the Agents SDK, Workers AI, Cloudflare Sandbox, Cloudflare Shell, and other Worker primitives where appropriate. Durable Objects give each agent conversation its own persistent state, durable execution, and global addressability out of the box.

The build is owned by Vite: `flue()` plus the official `@cloudflare/vite-plugin` in `vite.config.ts`, with `flue()` first. See [Deploy](/docs/guide/deploy/#deploy-on-cloudflare) for the plugin mechanics and [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for a deployment walkthrough.

## Generated Durable Objects

Flue generates a Durable Object class and a Wrangler binding for each agent found by the [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive) — one per exported agent function, so a module with several agents produces several classes. Both derive from the agent's identity — the exported function's name, or its [`agentName` static override](/docs/guide/building-agents/#use-agent-directive):

```txt
export function SupportChat() {…}   ->  FlueSupportChatAgent
                                        env.FLUE_SUPPORT_CHAT_AGENT
```

Camel boundaries split in the binding name, so `SupportChat` yields `FLUE_SUPPORT_CHAT_AGENT` (never `FLUE_SUPPORTCHAT_AGENT`); a kebab-case `agentName` like `support-chat` generates the same pair. The class name is how Cloudflare identifies the Durable Object in migrations. The binding is how your application code accesses the Durable Object namespace at runtime through `env`. Because both come from the identity, renaming the agent function is a storage-identity change unless `agentName` pins the identity — renaming the file changes nothing; see [Managing migrations](#managing-migrations).

Canonical agent conversation streams, immutable attachments, and accepted submissions are stored in the owning Durable Object's SQLite storage automatically. The Cloudflare target does not use `db.ts`; a source-root `db.ts` is rejected at build time.

Do not hand-author Flue's generated `FLUE_*` bindings in `wrangler.jsonc`. Declare migrations for generated classes, and declare bindings only for application-owned resources such as your own Durable Objects, R2 buckets, Queues, Hyperdrive configs, Browser Rendering bindings, or Send Email bindings.

## `wrangler.jsonc`

Your project's `wrangler.jsonc` at the project root configures your Worker's name, compatibility settings, and Durable Object migrations. Flue reads this file, merges its contributions (`main` and the per-agent Durable Object bindings) into a generated `.flue-vite.wrangler.jsonc` that the Cloudflare Vite plugin consumes, and never modifies your authored file. Add `.flue-vite/` and `.flue-vite.wrangler.jsonc` to `.gitignore`.

Flue generates the Durable Object classes and bindings, but your `wrangler.jsonc` must declare two things:

1. **`nodejs_compat`** in `compatibility_flags`, because Flue's runtime uses Node.js APIs.
2. **Durable Object migrations** that list every generated class. Cloudflare requires an explicit migration whenever a Worker adds, renames, or removes a Durable Object class.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["FlueSupportChatAgent"],
    },
  ],
}
```

### Managing migrations

Migration history stays user-authored — Flue never writes it, because it is an ordered, append-only record of your deployments. Adding an agent is always a triple: the exported agent function in a `'use agent'` module, the mount in `app.ts` (unless dispatch-only), and a new migration entry with a unique tag:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueSupportChatAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["FlueTriageAgent"] },
  ],
}
```

Never rewrite or reorder deployed migration entries. Generated agent classes require Durable Object SQLite, so introduce them through `new_sqlite_classes`, not legacy `new_classes`. Use Cloudflare's `renamed_classes` and `deleted_classes` migration fields when changing deployed class names or removing classes.

For example, if you remove an agent that was previously deployed, append a `deleted_classes` migration so Cloudflare knows the class is no longer exported. Without this entry, Wrangler will fail because the migration history references a class that the Worker no longer provides:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueSupportChatAgent", "FlueTriageAgent"] },
    { "tag": "v2", "deleted_classes": ["FlueTriageAgent"] },
  ],
}
```

Similarly, use `renamed_classes` when a deployed class changes its name — which for Flue agents means the agent's **identity** changed: the function was renamed, or its `agentName` pin was edited:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueSupportChatAgent"] },
    {
      "tag": "v2",
      "renamed_classes": [{ "from": "FlueSupportChatAgent", "to": "FlueSupportAssistantAgent" }],
    },
  ],
}
```

Renaming preserves the class's stored conversations under the new name. Re-mounting an agent at a different URL in `app.ts`, by contrast, needs no migration at all — the mount path is not part of the storage identity.

## Local development

`vite dev` runs your Worker in workerd via the Cloudflare plugin, with the same permissive dev CORS defaults as the Node target (Vite's middleware stack applies them before workerd sees the request). Flue keeps the generated inputs fresh: agent-set changes (adding or removing a `'use agent'` file, or an agent export within one) and authored `wrangler.jsonc` edits regenerate the entry and merged config, and the Cloudflare plugin picks them up. Writes are content-aware — editing an agent's body regenerates nothing, so there are no restart loops. `vite preview` and deployment come from the Cloudflare plugin; see [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/).

The plugin registers agents but mounts no routes. Your [`app.ts`](/docs/guide/routing/) remains the route map.

## Durable agent execution

Cloudflare agents durably admit direct HTTP prompts together with `dispatch(...)` inputs. All accepted input for one agent conversation enters the same queue.

```txt
direct HTTP prompt ─────────────────────┐
                                        ├→ durable per-conversation queue → canonical stream
dispatch(...) input ────────────────────┘
```

The submitting connection observes the work but does not own it. If a client disconnects after admission, backend work can continue. Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol.

Accepted work runs inside the Durable Object itself, as one platform-visible unit per response: after admission answers, Flue schedules a zero-delay wake, and the object's alarm invocation claims the queued submission and awaits the full response — every model turn and tool call — before completing. Admission always returns first; the response begins on the next alarm tick, typically within tens of milliseconds. Three consequences:

- **Platform observability sees agent work.** Workers Logs, Workers Traces, and invocation-wrapping integrations (the Sentry `wrap` pattern in [Extending Agents](#extending-agents-on-cloudflare)) attribute the whole response to the one invocation that ran it. [`createCloudflareTracing()`](#createcloudflaretracing) adds agent-level spans to those traces. See [Observability](/docs/guide/observability/#cloudflare) for the two views and [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/#observability) for enabling them.
- **Scheduled callbacks wait for a running response.** A Durable Object runs one alarm at a time, so `schedule()`/`scheduleEvery()` callbacks that come due mid-response fire after it settles — delivery is durable; timeliness is not guaranteed while the agent is busy. `queue()` is not alarm-driven and is unaffected. Steering is also unaffected: a message that arrives mid-response still joins it at the next turn boundary.
- **CPU limits are per invocation.** Agent responses are I/O-bound and sit far below the default 30-second active-CPU limit; raise [`limits.cpu_ms`](https://developers.cloudflare.com/durable-objects/platform/limits/) in `wrangler.jsonc` if an agent computes heavily.

When a Durable Object resumes after interruption, Flue decides what to do next from the stored input and canonical conversation progress. It requeues only when it can prove the input was not applied, recognizes already-completed output, and records an interruption instead of blindly repeating uncertain model or tool work.

For the full recovery model, see [Durability](/docs/guide/durability/).

## Calling a private agent over a service binding

A Flue Worker deployed without a public route can still be reached from another Worker through a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/). The Flue Agent SDK client sends every request through its `fetch` option, so point that option at the binding instead of the network:

```ts
import { createFlueClient } from '@flue/sdk';

type Env = { AGENT_APP: Fetcher };

export default {
  async fetch(request: Request, env: Env) {
    const convo = createFlueClient({
      // The host is never dialed — only the pathname and query select a route.
      // The URL must be absolute, so any placeholder origin works; the path is
      // wherever the agent app's app.ts mounts the agent, plus the conversation id.
      url: 'https://agent.internal/agents/support/ticket-42',
      fetch: (input, init) => env.AGENT_APP.fetch(new Request(input, init)),
    });

    const admission = await convo.send({
      message: { kind: 'user', body: 'Summarize this ticket.' },
    });

    return Response.json(admission);
  },
};
```

The binding carries the same HTTP requests the public routes use, so every client operation works over it — `send`, `wait`, `abort`, `history`, and `observe` in both `long-poll` and `sse` modes. Streaming reads travel through the same `fetch`, so live conversation updates cross the binding and the owning Durable Object with no extra wiring.

Attachments are the one exception. `convo.attachmentUrl(...)` returns a URL on the placeholder host and the client never fetches it for you; the same URL also appears on `file` parts in `observe()` and `history()` snapshots. To download attachment bytes over a binding, forward that URL through the same fetcher:

```ts
const url = convo.attachmentUrl(attachmentId);
const response = await env.AGENT_APP.fetch(new Request(url));
```

## Workers AI and AI Gateway

[Workers AI](https://developers.cloudflare.com/workers-ai/) lets you run AI models directly on Cloudflare's infrastructure without managing API keys or external provider accounts. Flue connects to Workers AI on the Cloudflare target (with a [`providers` list](/docs/reference/provider-api/#the-providers-config), name `'cloudflare'` to include it), so using a Workers AI model is as simple as specifying the model name:

```ts
export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
}
```

No API key is needed. Authorization and billing follow the Worker account, including the [Workers AI free tier](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Flue also enables [AI Gateway](https://developers.cloudflare.com/ai-gateway/) by default for all `cloudflare/...` models, giving you caching, request logging, rate limiting, and budget controls in the Cloudflare dashboard out of the box.

To customize the gateway, disable it, or target a named gateway, re-register the `cloudflare` provider in `app.ts`. See [Cloudflare Workers AI](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) for examples.

## Cloudflare Sandbox

[Cloudflare Sandbox](https://developers.cloudflare.com/containers/) provides container-backed Linux environments for agents that need tools such as git, package installation, native binaries, or a real filesystem. Export the sandbox Durable Object class from `cloudflare.ts`, declare its binding and container image in `wrangler.jsonc`, then wrap the RPC stub returned by `getSandbox(...)` with `cloudflareSandbox(...)`:

```ts
'use agent';
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

export function Assistant({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)), { cwd: '/workspace' });
}
```

See [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) for container configuration and lifecycle guidance.

## Codemode

By default, Flue agents use a lightweight in-memory virtual sandbox. This is fast and sufficient for prompt-and-response agents or agents that only need tools and structured results. When an agent needs a durable workspace with structured code execution instead of a full Linux container, use Cloudflare Shell with Codemode.

[Cloudflare Shell](https://developers.cloudflare.com/agents/api-reference/cloudflare-shell/) provides a durable `Workspace` with a model-facing `code` tool backed by [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/api-reference/codemode/). The agent interacts with files through structured code operations rather than shell commands. This means `harness.sandbox.exec(...)` does not run arbitrary Linux commands through this sandbox adapter — it throws, since the Workspace has no shell.

Add the sandbox adapter to your project:

```bash
pnpm exec flue add sandbox cloudflare-shell
```

Then import its helpers from your generated sandbox adapter file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';
```

Use Cloudflare Shell when a durable Workspace and structured code operations are enough. Use Cloudflare Sandbox when you need a full Linux environment with arbitrary shell access. See [Cloudflare Shell](/docs/ecosystem/sandboxes/cloudflare-shell/) for setup details.

## Extending Agents on Cloudflare

Flue owns each generated Durable Object class. When an agent needs access to native Cloudflare Agents SDK capabilities such as `onStart()`, `schedule()`, `scheduleEvery()`, or `queue()`, export a `cloudflare` extension descriptor from its module:

```ts
'use agent';
import { useModel } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
}

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

`base` receives the Agents SDK `Agent` base class. Flue applies it before defining the final generated Durable Object subclass, so your authored methods and lifecycle hooks are available on the generated class. The `cloudflare` export is per-module: when a marked file exports several agents, the extension applies to every generated class in that file.

`wrap` receives the final generated class and may return a prototype-preserving constructor wrapper. Use it for integrations like Sentry that instrument the class without replacing its prototype:

```ts
export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry((env) => ({ dsn: env.SENTRY_DSN }), Final),
});
```

Both `base` and `wrap` are optional. Do not override Flue-owned `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()` methods.

Use this module-local extension point for scheduled or queued behavior that belongs to one generated agent Durable Object. Scheduled callbacks share the object's alarm with agent execution: a `schedule()`/`scheduleEvery()` callback that comes due while a response is running fires after that response settles — see [Durable agent execution](#durable-agent-execution). Do not add a Worker cron trigger just to reach `scheduleEvery(...)`; the Agents SDK scheduling APIs run inside the generated Durable Object after that object is created. If your application needs to create the first conversation, expose an authenticated bootstrap route in `app.ts` or otherwise obtain the Durable Object namespace from `env` and address the conversation once.

## Extending `cloudflare.ts` Entrypoint

Your project may include a source-root `cloudflare.ts` file for Worker-level Cloudflare code that is separate from individual agent modules.

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

After exporting the class, declare its Durable Object binding and migration in `wrangler.jsonc`. Your agents can then access it through `env.SALESFORCE_AUTH_CACHE`.

The **default export** may contribute non-HTTP Worker handlers. For example, a `scheduled` handler that runs on a cron trigger:

```ts title="src/cloudflare.ts"
export default {
  async scheduled(_controller, env) {
    await env.SALESFORCE_AUTH_CACHE.getByName('default').refreshIfNeeded();
  },
};
```

Use `app.ts` for custom HTTP routes and middleware. `cloudflare.ts` must not define a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

Use `cloudflare.ts` for Worker-level events such as inbound email, queues, or cron handlers that are not owned by a specific generated agent class. To deliver scheduled input to an agent from one of these handlers, import the agent function and call `dispatch(Agent, { id, message })` — dispatch needs no mount and bypasses HTTP middleware. See [Schedules](/docs/guide/schedules/) for a Cron Trigger example.

## Reference

### `extend(...)`

```ts
import { extend } from '@flue/runtime/cloudflare';

function extend<TBase extends object = CloudflareAgentLike, TEnv = any>(
  extension: CloudflareExtension<TBase, TEnv>,
): CloudflareExtension<TBase, TEnv>;
```

Creates a branded Cloudflare extension descriptor for an agent module. The descriptor may contain `base` and `wrap` callbacks.

Both callbacks are typed against `CloudflareAgentLike`, a structural view of the Agents SDK `Agent` base class covering `state`, `setState()`, `onStart()`, `schedule()`, `scheduleEvery()`, and `queue()`, so typos inside `base` callbacks fail at typecheck. Pass an explicit `TBase` (for example `extend<CloudflareAgentLike<MyState>>({ ... })`) to type against a richer class shape, and an explicit `TEnv` to type the `env` an instrumentation callback receives.

`base(Base)` must return the received class or a subclass. Flue uses its return value as the superclass for the generated Durable Object.

`wrap(Final)` must return the received class or a prototype-preserving constructor wrapper. Use it for integrations that instrument or proxy the final generated class without replacing its prototype. Subclasses are rejected; only the same class or a `new Proxy(Final, {...})` pattern is allowed. The class both callbacks receive is typed as a real Durable Object constructor, so brand-checked wrappers such as `@sentry/cloudflare`'s `instrumentDurableObjectWithSentry` accept it directly, with no casts or explicit generics.

Both callbacks are optional. When omitted, the corresponding step is an identity operation.

### `getCloudflareContext()`

```ts
import { getCloudflareContext } from '@flue/runtime/cloudflare';

function getCloudflareContext(): CloudflareContext;
```

Returns the current Cloudflare runtime context. Only valid while code is running inside a Worker or Durable Object request handler.

The returned `CloudflareContext` includes:

- `env` -- the Worker's environment bindings.
- `storage` -- the Durable Object's `{ sql }` SQLite storage handle.

Throws outside of Cloudflare runtime work.

This is intended for advanced application-owned integrations such as custom Cloudflare sandbox adapters. Most applications do not need to call this directly.

### `getDurableObjectIdentity()`

```ts
import { getDurableObjectIdentity } from '@flue/runtime/cloudflare';

function getDurableObjectIdentity(): FlueDurableObjectIdentity;
```

Returns the generated Durable Object identity for the current agent context. Only valid inside a generated Durable Object request handler.

The returned `FlueDurableObjectIdentity` includes:

- `bindingName` -- the Wrangler binding name, such as `"FLUE_SUPPORT_CHAT_AGENT"`.
- `className` -- the generated class name, such as `"FlueSupportChatAgent"`.
- `name` -- the instance name passed to `idFromName` or `getAgentByName`.
- `id` -- the Durable Object ID as a string.

Throws when called outside a generated Durable Object context.

### `createCloudflareTracing()`

```ts
import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';

function createCloudflareTracing(options?: CloudflareTracingOptions): FlueInstrumentation;

interface CloudflareTracingOptions {
  content?: false | { transform?(content: unknown, scope: GenAIContentScope): unknown | undefined };
}
```

Creates the native [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/) instrumentation for agent execution. Install it once at `app.ts` module scope with `instrument(...)`, and enable traces in `wrangler.jsonc` (see [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/#observability)):

```ts title="src/app.ts"
instrument(createCloudflareTracing());
```

Each agent response's trace then carries agent-level spans nested under the invocation that ran it:

- `invoke_agent {agent}` -- the whole run, with `gen_ai.agent.name`, `gen_ai.agent.id` (the instance), `gen_ai.conversation.id`, aggregate `gen_ai.usage.*` token counts, and the caller's input and output messages.
- `chat {model}` -- one per model turn (compaction turns included), with request and response model identity, per-turn `gen_ai.usage.*`, the finish reason, and the turn's messages, system instructions, and tool definitions. Provider `fetch` subrequests nest inside it.
- `execute_tool {tool}` -- one per tool call, with `gen_ai.tool.name`, `gen_ai.tool.call.id`, and the call's arguments and result. Subagent task runs appear as nested `invoke_agent` spans instead.

Span names and attributes follow the OpenTelemetry GenAI conventions that Cloudflare's own agent tracing emits, so Flue agents read natively in the Traces dashboard; Flue-specific keys live under `flue.*`.

**Content is on by default** — installing the adapter is the opt-in; nothing is emitted by merely deploying. Pass `content: false` for content-free spans, or a `transform` to apply policy in code:

```ts title="src/app.ts"
instrument(
  createCloudflareTracing({
    content: {
      transform(content, scope) {
        if (scope.contentType === 'tool_result') return undefined; // omit entirely
        return scrubPII(content);
      },
    },
  }),
);
```

The transform runs on a detached copy; returning `undefined` omits that content, and a throwing transform emits a `[flue]` failure sentinel rather than the unredacted content. After the transform, a fixed 56 KiB per-attribute safety budget is enforced **in-band**: payloads stay valid JSON, oldest messages drop first behind a `role: "flue"` sentinel message, and oversized strings are cut with a `[flue:truncated, N more bytes]` suffix — search for `[flue]` in the dashboard to find truncated content. `truncateContent` from `@flue/runtime/telemetry` is the same algorithm, exported for tighter budgets inside a transform.

Two exclusions hold regardless of policy: raw error messages and stack traces never ship on this backend — a failed span records only a low-cardinality `error.type`, and aborted work is marked `flue.canceled` rather than counted as an error — and caller-origin shell (`bash`) operations stay content-free.

The adapter records nothing when traces are disabled in `wrangler.jsonc`, when the invocation is unsampled, or on runtimes that predate the Workers custom-spans API, so leaving it installed costs effectively nothing. `instrument()` returns a dispose function, but nothing on Cloudflare needs to call it: the isolate's lifetime is the disposal.
