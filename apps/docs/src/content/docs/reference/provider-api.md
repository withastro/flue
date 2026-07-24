---
title: Provider API
description: Reference for the providers config, setProvider(), model resolution, and the Cloudflare AI binding provider in @flue/runtime.
lastReviewedAt: 2026-07-21
---

Flue's model layer is [Pi](https://pi.dev/docs/latest/providers)'s provider protocol, unwrapped: a provider is a Pi `Provider` object, and the runtime holds one Pi `Models` registry that every model call resolves against. Flue adds three things — a build-time [`providers` config](#the-providers-config) that selects which built-ins ship, [`setProvider()`](#setprovider) to register providers at runtime, and [`cloudflareBindingProvider()`](#cloudflarebindingprovider) for Workers AI dispatch through `env.AI`. Everything else — provider objects, auth resolution, custom endpoints — is Pi's own API, used directly. For a walkthrough, see [Models — Custom providers](/docs/guide/models/#custom-providers); this page is the complete contract.

Exports:

```ts
import { setProvider } from '@flue/runtime';
import {
  cloudflareBindingProvider,
  type CloudflareAIBinding,
  type CloudflareBindingProviderOptions,
} from '@flue/runtime/cloudflare/workers-ai';
import { type CloudflareGatewayOptions } from '@flue/runtime/cloudflare';

// Provider construction is Pi's API, used directly:
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
```

## The `providers` config

```ts
// vite.config.ts
flue({ providers: ['anthropic', 'openai'] });
```

Selects which providers the generated server entry registers, by provider ID. Each entry maps to a `@earendil-works/pi-ai/providers/<id>` factory import in the generated entry — except `'cloudflare'`, which selects Flue's own [Workers AI binding provider](#cloudflarebindingprovider) — so only the listed providers (their catalogs and lazily-loaded protocol implementations) ship in the build.

- **Omitted: every built-in registers**, the Workers AI binding provider included on the Cloudflare target. The default preserves zero-config resolution — any `'provider/model-id'` specifier from Pi's catalog works, with credentials from the provider's environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...).
- **Set: the list is exhaustive.** A specifier naming an unlisted provider fails at [model resolution](#model-resolution), and on the Cloudflare target the binding provider is registered only when the list names `'cloudflare'`. Naming `'cloudflare'` on the Node target is a config error (the binding only exists on Workers). Custom providers are unaffected — register those with [`setProvider()`](#setprovider).
- **An unknown ID fails the build.** The generated import `@earendil-works/pi-ai/providers/<id>` does not resolve, and the build error names it.
- **User registrations win.** The generated registrations skip any provider ID already registered, so a `setProvider()` in `app.ts` overrides a listed built-in regardless of module evaluation order.
- **[`flue run`](/docs/cli/run/) ignores the list.** It loads only the agent module — no `app.ts`, no generated entry — and always registers the full built-in set. The narrowing is a server-build concern.

The same field is accepted in `flue.config.ts`; inline plugin options win per field. See [Configuration](/docs/reference/configuration/#providers).

## `setProvider()`

```ts
function setProvider(provider: Provider): void;
```

Registers a Pi `Provider` with the runtime, keyed by `provider.id`: after `setProvider(p)` with `p.id === 'acme'`, the specifier `'acme/some-model'` resolves through it. Accepts any `Provider` — a built-in factory (`anthropicProvider()`), [`createProvider(...)`](https://pi.dev/docs/latest/providers#custom-providers) for custom endpoints, [`cloudflareBindingProvider(...)`](#cloudflarebindingprovider), or a faux provider's `.provider` in tests.

```ts
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'ollama',
    auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
    models: [/* Model objects; each carries its own baseUrl */],
    api: openAICompletionsApi(),
  }),
);
```

Behavior:

- **Each call replaces the ID's previous provider.** Calls do not accumulate or merge; the latest `setProvider()` for an ID wins, including over the generated entry's built-in registrations (which skip already-registered IDs).
- **The registry is module-scoped and in-memory.** Call `setProvider()` at module top level, before any agent runs. On the Node.js target one process hosts all agents, so a registration in `app.ts` covers everything. On the Cloudflare target each agent conversation runs in its own Durable Object isolate; `app.ts` is evaluated in every isolate, so top-level registrations apply everywhere. [`flue run`](/docs/cli/run/) loads only the agent module, never `app.ts` — put the registration in the agent module when it must also apply there.
- **Registration is declarative and deferred.** The call performs no network I/O and no credential validation; a wrong endpoint or key surfaces as a provider error on the first model request. There is no public unregister function.
- **Credentials resolve through the provider's own `auth`.** Built-in factories carry Pi's environment-variable resolution (`envApiKeyAuth`); custom providers declare their own resolver — a fixed key, an env read, or a dynamic exchange. Flue adds no credential layer on top. See [Pi — Authentication](https://pi.dev/docs/latest/providers#authentication).

## Model resolution

A model specifier is `'provider-id/model-id'`, split at the first `/`. Resolution happens per model call, against the live registry:

1. The provider ID must be registered — via the [`providers` config](#the-providers-config) defaults or [`setProvider()`](#setprovider). Unknown provider IDs throw, naming the registered IDs and both registration paths.
2. The model ID must be one the provider declares (`provider.getModels()`). Unknown model IDs throw, listing the declared IDs.
3. Exception: a provider carrying a dynamic-model template — [`cloudflareBindingProvider()`](#cloudflarebindingprovider) is the only one Flue ships — resolves undeclared model IDs with zero metadata: `reasoning: false` (a forwarded `thinkingLevel` is silently dropped), `input: ['text']` (image blocks are replaced with an `"(image omitted)"` placeholder), `contextWindow: 0` (unknown — threshold [compaction](/docs/guide/models/#compaction) cannot engage), `maxTokens: 0`, and all-zero cost.

Resolution failures throw plain `Error`s (not `FlueError` categories), raised when the model call resolves the specifier. A specifier with no `/`, or with an empty model ID (`'acme/'`), is invalid.

Model metadata — context window, cost, reasoning capability, input modalities, per-model headers — lives on the `Model` objects the provider declares. To override metadata for a built-in provider, register a replacement provider whose models carry the values you need (see [Models — Custom providers](/docs/guide/models/#custom-providers)); there is no separate override surface.

## `cloudflareBindingProvider()`

```ts
function cloudflareBindingProvider(options: CloudflareBindingProviderOptions): Provider;

interface CloudflareBindingProviderOptions {
  binding: CloudflareAIBinding; // env.AI
  gateway?: CloudflareGatewayOptions | false;
}
```

Builds the `cloudflare` provider: Pi models dispatched through a [Workers AI binding](https://developers.cloudflare.com/workers-ai/)'s `run(modelId, payload, options)` in-process — no `baseUrl`, no `apiKey`, no HTTP endpoint. The binding and resolved gateway options are captured in the provider's closure. Exported from its own subpath, `@flue/runtime/cloudflare/workers-ai`: importing the factory is what puts the binding dispatch code in a build, so it deliberately does not ride along with the `@flue/runtime/cloudflare` barrel.

- `binding` — the captured `env.AI` reference.
- `gateway` — [AI Gateway](https://developers.cloudflare.com/ai-gateway/) routing for every `run` call through this provider. Tri-state: omitted routes through Cloudflare's default AI Gateway (the options object `{ id: 'default' }`, which the binding provisions on demand for the account); a [`CloudflareGatewayOptions`](#cloudflaregatewayoptions) object replaces the default; `false` opts out — no gateway option is passed to `run`.

Behavior:

- **Registration on the Cloudflare target.** When the [`providers` config](#the-providers-config) is omitted or names `'cloudflare'`, the generated Worker entry runs `setProvider(cloudflareBindingProvider({ binding: env.AI }))` — unless a provider with the `cloudflare` ID is already registered. `app.ts` imports are hoisted above the generated entry's body, so a user registration always wins; this is how a project targets a named gateway, tunes caching, or opts out. A `providers` list without `'cloudflare'` emits neither the registration nor the import. See [Models — Cloudflare Workers AI](/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) and the [Cloudflare target guide](/docs/guide/cloudflare-target/#workers-ai-and-ai-gateway).
- **Metadata hydration.** The provider declares Pi's `cloudflare-workers-ai` catalog, re-tagged onto the `cloudflare` ID. Listed model IDs keep their catalog metadata (context window, cost, reasoning, input); any other ID still resolves — the binding accepts arbitrary model IDs — with the zero-metadata defaults from [Model resolution](#model-resolution).
- **Wire format.** Model IDs prefixed `anthropic/` are sent as Anthropic Messages requests; all other IDs use the OpenAI-compatible chat-completions shape. Both go through `binding.run` with `returnRawResponse: true` and the resolved `gateway` option.
- **Failures.** Non-OK binding responses throw `CloudflareAIBindingError` (`type: 'cloudflare_ai_binding_error'`), exported from `@flue/runtime/cloudflare`; a 413 additionally carries `meta.reason: 'request_too_large'` and triggers compaction recovery. See [Errors — `CloudflareAIBindingError`](/docs/reference/errors/#cloudflareaibindingerror).
- **Node import safety.** The factory and its types are importable on Node.js (the binding shape is structural); only calling a model through it requires a real binding.

## `CloudflareGatewayOptions`

```ts
interface CloudflareGatewayOptions {
  id: string;
  skipCache?: boolean;
  cacheTtl?: number;
  cacheKey?: string;
  metadata?: Record<string, number | string | boolean | null | bigint>;
  collectLog?: boolean;
  eventId?: string;
  requestTimeoutMs?: number;
}
```

AI Gateway options forwarded verbatim as the `gateway` option on every `binding.run(...)` call routed through a [`cloudflareBindingProvider()`](#cloudflarebindingprovider). The shape mirrors [Cloudflare's Worker binding methods documentation](https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/), which defines each field's provider-side semantics. Exported from `@flue/runtime/cloudflare`.

- `id` — the AI Gateway ID (slug) to route through. Required whenever gateway options are specified.
- `skipCache` — bypass the gateway cache for the request.
- `cacheTtl` — cache TTL override, in seconds.
- `cacheKey` — cache key override.
- `metadata` — arbitrary metadata surfaced on the gateway log entry.
- `collectLog` — force collecting (or not collecting) request logs.
- `eventId` — custom event ID for log correlation.
- `requestTimeoutMs` — per-request timeout enforced by the gateway, in milliseconds.

## `CloudflareAIBinding`

```ts
interface CloudflareAIBinding {
  run(
    modelId: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Response | Record<string, unknown>>;
}
```

The minimal structural shape of a Workers AI binding, exported from `@flue/runtime/cloudflare`. It is deliberately structural — not Cloudflare's `Ai` type — so the factory stays importable on Node.js. Pass the real `env.AI` binding as [`CloudflareBindingProviderOptions`](#cloudflarebindingprovider)' `binding`.

## Provider telemetry

[Model-turn observability events](/docs/reference/events/#turn_start-turn_request-turn-turn_messages) (`turn_request.request` and `turn.request`) identify the provider with a fixed normalization of the provider ID to observability conventions (`ModelRequestInfo.providerName`); IDs outside the table pass through unchanged. The reported server host and port are parsed from the resolved model's `baseUrl`.

| Provider ID                   | `providerName`    |
| ----------------------------- | ----------------- |
| `amazon-bedrock`              | `aws.bedrock`     |
| `azure-openai-responses`      | `azure.ai.openai` |
| `google`                      | `gcp.gemini`      |
| `google-vertex`               | `gcp.vertex_ai`   |
| `mistral`                     | `mistral_ai`      |
| `moonshotai`, `moonshotai-cn` | `moonshot_ai`     |
| `xai`                         | `x_ai`            |

The same events always report the provider ID unmodified as `ModelRequestInfo.providerId`.

## What registration does not change

- **Pi's catalog itself.** A registration shadows one provider ID at resolution time; it never adds, removes, or edits catalog entries.
- **Anything durable.** Registrations live in process memory for the current module scope. They are not persisted, not shared across processes or isolates, and rebuilt from module top-level code on every boot.
- **Earlier registrations of other provider IDs.** Each call affects exactly one provider ID.
