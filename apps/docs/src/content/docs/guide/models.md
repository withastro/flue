---
title: Models
description: Choose, tune, and connect the LLM that powers your agent with the useModel hook.
lastReviewedAt: 2026-07-21
---

Every agent is powered by exactly one LLM at a time, declared with `useModel()` — the single required hook in Flue. This guide covers choosing a model, tuning how it's called, when a change takes effect, supplying provider credentials, and connecting providers Flue doesn't know out of the box.

## Declaring a model

Call `useModel()` in your agent function's body with a model specifier string:

```ts title="src/agents/triage.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}
```

`useModel()` is a declaration, not a client: it returns nothing, and you never construct an SDK object or pass an API key through your agent code. You name the model; the Flue runtime owns the connection, authentication, streaming, and retries behind it.

Two rules:

- **The call is required.** An agent render without a `useModel()` call cannot start.
- **Call it exactly once per render.** An agent has one model. The _argument_ may change from render to render (more on that [below](#changing-models-mid-conversation)), but the call itself may not disappear or repeat.

The call can live in the agent body or in a [custom hook](/docs/guide/agent-hooks/#custom-hooks) the body calls. The one place it's not available is a subagent render — a delegate's model is set on its `useSubagent()` definition instead, and it inherits the parent's model when unset. See [Subagents](/docs/guide/subagents/).

## Model specifier

A model specifier is a plain string in `'provider-id/model-id'` format. Everything up to the first `/` names the provider; the rest is the provider's own model ID, which may itself contain slashes:

- `anthropic/claude-sonnet-4-6` — provider `anthropic`, model `claude-sonnet-4-6`
- `openai/gpt-5.5` — provider `openai`, model `gpt-5.5`
- `openrouter/moonshotai/kimi-k2.6` — provider `openrouter`, model `moonshotai/kimi-k2.6`
- `cloudflare/@cf/moonshotai/kimi-k2.6` — provider `cloudflare`, model `@cf/moonshotai/kimi-k2.6`

Flue resolves specifiers against the providers registered with the runtime. By default that is the full built-in set from [Pi](https://pi.dev/docs/latest/providers), which ships the major providers — `anthropic`, `openai`, `google`, `amazon-bedrock`, `google-vertex`, `groq`, `mistral`, `xai`, `deepseek`, `cerebras`, `together`, `fireworks`, `openrouter`, and more. Each provider's catalog entries carry the model's wire protocol, endpoint, context-window size, output-token limit, cost rates, reasoning support, and accepted input modalities. That metadata decides when [compaction](#compaction) triggers, whether a [thinking level](#model-reasoning-effort) reaches the wire, and whether the model can accept images.

To ship only the providers you actually use, list them in the `flue()` plugin config — the generated server entry then imports just those factories, and nothing else enters the build:

```ts title="vite.config.ts"
flue({ providers: ['anthropic', 'openai'] });
```

With a `providers` list set, a specifier naming any other provider fails at resolution — the list is exhaustive, so on the Cloudflare target include `'cloudflare'` when your agents use `cloudflare/...` models. Omit the field to keep the full set. See the [Provider API reference](/docs/reference/provider-api/#the-providers-config) for the exact semantics.

An unknown specifier fails fast: the run errors with the unresolved provider and model ID before any request is sent. To teach Flue a specifier no built-in provider serves — a local model, a proxy, a brand-new release — register a provider yourself; see [Custom providers](#custom-providers).

On the Cloudflare target there is one more built-in provider ID: `cloudflare/...` model specifiers run on [Workers AI](#cloudflare-workers-ai-cloudflare-only) with no API key at all.

## Model reasoning effort

`useModel()` accepts an options object as its second argument with two fields: `thinkingLevel` and `compaction`.

```ts
useModel('anthropic/claude-opus-4-6', {
  thinkingLevel: 'high',
  compaction: { keepRecentTokens: 16000 },
});
```

`thinkingLevel` sets the default reasoning effort for the agent's model calls: `'off'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'`, or `'max'`. When you don't set it, the runtime uses `'medium'`.

Higher levels increase reasoning depth at the cost of latency and tokens; `'off'` disables extended thinking entirely. The value is a _default_: individual operations may override it — a [subagent definition](/docs/guide/subagents/) can pin its own `thinkingLevel`, and programmatic `harness.prompt(...)` calls accept one per operation.

Thinking only reaches the wire for models marked reasoning-capable. Catalog models carry that flag already, but if you register a custom provider and skip its `reasoning` metadata, a forwarded `thinkingLevel` is silently dropped. See [Custom providers](#custom-providers).

## Compaction

Agent conversations can outlive any context window. As a conversation approaches the model's limit, Flue automatically **compacts** it: older history is folded into a summary while recent messages stay verbatim, and the conversation continues. The `compaction` option tunes that behavior:

```ts
useModel('anthropic/claude-opus-4-6', {
  compaction: {
    // Trigger earlier or later: compaction runs when used tokens
    // exceed contextWindow - reserveTokens. Default: model-aware, ≤ 20000.
    reserveTokens: 30000,
    // How much recent history survives verbatim. Default: 8000.
    keepRecentTokens: 16000,
    // Summarize with a cheaper model than the session runs on.
    model: 'anthropic/claude-haiku-4-5',
  },
});
```

All three fields are optional; each overrides a model-aware default. Setting `compaction.model` offloads summarization to a cheaper model.

Passing `compaction: false` disables _threshold_ compaction — the automatic trigger. Overflow recovery and explicit `harness.compact()` calls still compact when the conversation no longer fits. The full field reference lives at [`CompactionConfig`](/docs/reference/agent-hooks-api/#compactionconfig).

## Changing models mid-conversation

The agent function re-renders before every model call, and `useModel()` runs again each time — so the specifier can be computed, not constant. A common pattern is escalation, where durable state moves an agent from a cheap model to a strong one:

```ts title="src/agents/reviewer.ts"
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';

export function Reviewer() {
  const [escalated, setEscalated] = usePersistentState('escalated', false);
  useModel(escalated ? 'anthropic/claude-opus-4-6' : 'anthropic/claude-haiku-4-5');

  useTool({
    name: 'escalate_review',
    description: 'Escalate when the change is too complex for a quick pass.',
    async run() {
      setEscalated(true);
      return 'Escalated. A stronger model will take over.';
    },
  });

  return 'Review the proposed change and leave actionable feedback.';
}
```

The model, thinking level, and compaction settings are **submission-scoped**: the runtime reads them once, when the agent wakes to process an accepted input (a _submission_ — see [Durability](/docs/guide/durability/)). A different value computed by a re-render mid-run latches and takes effect on the _next_ submission, not in the middle of the current one. In the example above, the response where `escalate_review` fires finishes on the cheap model; the conversation's next message runs on the strong one.

There is no per-message model parameter on `dispatch(...)` or the HTTP surface: the model choice belongs to the agent function.

## Provider credentials

Model providers authenticate with API keys, and the runtime resolves them from the environment — your agent code never handles them.

### Local development

Put keys in a `.env` file at the project root, using the variable name each provider expects:

```bash title=".env"
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="..."
```

`anthropic` reads `ANTHROPIC_API_KEY`, `openai` reads `OPENAI_API_KEY`, `google` reads `GEMINI_API_KEY`, `groq` reads `GROQ_API_KEY` — the pattern holds across providers (see [Pi's provider documentation](https://pi.dev/docs/latest/providers) for the full list). Both local entry points load the file for you, with shell-exported values always winning over file values:

- [`flue run`](/docs/cli/run/) loads the project-root `.env`; pass `--env <path>` to select one alternate file.
- `vite dev` loads Vite's standard file set: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`.

Don't commit `.env` files.

### Deployed environments

Deployed servers read only the real environment — no `.env` loading:

- **Node.js** — supply keys as process environment variables through your host's secret mechanism. See [Node.js target — Environment and secrets](/docs/guide/node-target/#environment-and-secrets).
- **Cloudflare** — add each key as a Worker secret (`npx wrangler secret put ANTHROPIC_API_KEY`); locally, `.dev.vars` plays the `.env` role. See the [Cloudflare deploy guide](/docs/ecosystem/deploy/cloudflare/).

When the environment-variable convention doesn't fit — a gateway with its own credential, a secret manager that hands you the value in code — declare the credential on a [custom provider](#custom-providers): a provider's `auth.apiKey.resolve()` returns whatever your code produces, and it runs per request, so rotating credentials work too.

## Custom providers

Providers are [Pi](https://pi.dev/docs/latest/providers)'s own objects, and Flue accepts them directly: build one with Pi's `createProvider()` (or any provider factory) and hand it to `setProvider()` at module top level in `app.ts`, before any agent runs. Since your code now imports Pi directly, add it to your project's dependencies: `npm install @earendil-works/pi-ai`. Registrations are keyed by the provider's `id`, and each call replaces that ID's previous provider — including a built-in, so overriding `anthropic` is just registering your own provider under that ID. One placement caveat: [`flue run`](/docs/cli/run/) loads only the agent module, never `app.ts` — when an agent must also work under `flue run`, put the registration in the agent module instead.

Any OpenAI- or Anthropic-compatible endpoint works. Here's a local Ollama server:

```ts title="src/app.ts"
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'ollama',
    // Keyless local server; use envApiKeyAuth('...', ['MY_KEY']) for real keys.
    auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
    models: [
      {
        id: 'llama3.1:8b',
        name: 'Llama 3.1 8B (local)',
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    api: openAICompletionsApi(),
  }),
);
```

```ts title="src/agents/local-assistant.ts"
useModel('ollama/llama3.1:8b');
```

The provider declares its models, and the runtime trusts that metadata: `reasoning: false` means a `thinkingLevel` is silently dropped, `input: ['text']` means attached images are replaced with an "(image omitted)" placeholder, and `contextWindow: 0` reads as unknown, so threshold compaction can't engage.

Routing a built-in provider through a gateway or proxy is the same move — register your own provider under the built-in's ID, reusing its catalog models with your endpoint and credential:

```ts title="src/app.ts"
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'anthropic',
    auth: {
      apiKey: {
        name: 'Gateway key',
        resolve: async () => ({ auth: { apiKey: process.env.GATEWAY_KEY } }),
      },
    },
    models: anthropicProvider()
      .getModels()
      .map((model) => ({ ...model, baseUrl: 'https://gateway.example.com/anthropic' })),
    api: anthropicMessagesApi(),
  }),
);
```

The agents' specifiers (`anthropic/claude-sonnet-4-6`) don't change; cost, context-window, and capability metadata ride along from the catalog. Pi's provider protocol goes much further when you need it — OAuth, dynamic model discovery, custom wire protocols via the `api` field — all documented in [Pi's provider guide](https://pi.dev/docs/latest/providers#custom-providers). Flue's own contract is in the [Provider API reference](/docs/reference/provider-api/).

## Cloudflare Workers AI (Cloudflare only)

On the Cloudflare target, the `cloudflare` provider ID is registered automatically and runs models on [Workers AI](https://developers.cloudflare.com/workers-ai/) — no API key, no external account; authorization and billing follow the Worker, including the [Workers AI pricing and daily free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/):

```ts title="src/agents/assistant.ts"
export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  return 'Help the user with their question.';
}
```

Declare the `AI` binding the provider uses in your project's Wrangler configuration:

```jsonc title="wrangler.jsonc"
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "ai": {
    "binding": "AI",
  },
}
```

Everything after `cloudflare/` is passed as the model ID to `env.AI.run(...)`. That can be a Workers AI model ID such as `@cf/moonshotai/kimi-k2.6`, or a binding-supported AI Gateway model ID such as `openai/gpt-5.5` when the Worker should reach that model through Cloudflare's gateway path — `cloudflare/openai/gpt-5.5` bills through Cloudflare, while plain `openai/gpt-5.5` uses Flue's direct OpenAI provider and its API key.

By default, every `cloudflare/...` call routes through Cloudflare's [AI Gateway](https://developers.cloudflare.com/ai-gateway/), giving you caching, logging, and budget controls in the dashboard out of the box. To target a named gateway, tune caching and logging, or opt out, register the `cloudflare` provider yourself in `app.ts` — your registration wins over the generated default:

```ts title="src/app.ts"
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { env } from 'cloudflare:workers';

setProvider(
  cloudflareBindingProvider({
    binding: env.AI,
    gateway: { id: 'my-gateway', cacheTtl: 300, metadata: { tenant: 'acme' } },
    // ...or `gateway: false` to bypass AI Gateway entirely.
  }),
);
```

Cloudflare's model surface is also reachable from any target through two ordinary catalog providers: `cloudflare-workers-ai/...` (URL-backed Workers AI) and `cloudflare-ai-gateway/...` (URL-backed AI Gateway), both authenticating with `CLOUDFLARE_API_KEY` like any other hosted provider. See the [Cloudflare target guide](/docs/guide/cloudflare-target/#workers-ai-and-ai-gateway) for the target's full model story.

## Next steps

- [Agent Hooks API](/docs/reference/agent-hooks-api/#usemodel) — the full `useModel()` contract, `ThinkingLevel`, and `CompactionConfig`.
- [Provider API](/docs/reference/provider-api/) — the `providers` config, `setProvider()`, and `cloudflareBindingProvider()`.
- [Subagents](/docs/guide/subagents/) — give a delegate its own model and thinking level.
- [Durability](/docs/guide/durability/) — what a submission is and how interrupted model work recovers.
- [Observability](/docs/guide/observability/) — inspect model calls, token usage, and provider diagnostics.
