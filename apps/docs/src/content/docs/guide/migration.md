---
title: Migration Guide
description: Upgrade an application from Flue 1.0.0-beta.x to v2.0.0 — build, routing, agents, tools, workflows, SDK, and deployment.
lastReviewedAt: 2026-07-23
---

This guide migrates a Flue codebase from `1.0.0-beta.9` to Flue 2. It is written for working beta applications: every section pairs the beta API with its replacement, and the [checklist](#migration-checklist) at the end orders the work.

The release is a breaking version upgrade and major redesign of core internal architecture. Five conceptual changes drive the upgrade:

- `flue build` / `flue dev` CLI commands — replaced by [Vite](/docs/guide/deploy/) with the `flue()` plugin; `vite dev` and `vite build` are the only commands.
- The auto-mounted `flue()` router and discovery by directory — replaced by [explicit routing](/docs/guide/routing/) in `app.ts`; the [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive) registers agents.
- `defineAgent(async initializer => config)` with a config bag — the agent **is** the function now: an exported capitalized agent function composing behavior with [Agent Hooks](/docs/reference/agent-hooks-api/); `defineAgent` is gone entirely.
- Workflows (`defineWorkflow`, `invoke()`, runs, run events) — removed. Use awaited [`init()` handles](/docs/guide/building-agents/#standalone-scripts), [durable tools](/docs/guide/tools/#durable-tools), or your own orchestrator. See [Workflows](/docs/guide/workflows/).
- The deployment-wide SDK client (`client.agents.*`, `client.workflows.*`) — replaced by the [Flue Agent SDK's conversation-scoped client](/docs/sdk/create-flue-client/): one client per conversation URL.

This guide maps old code onto new APIs; it does not teach the new APIs. Read [Agents](/docs/guide/building-agents/), [Agent Hooks](/docs/guide/agent-hooks/), [Routing](/docs/guide/routing/), and [Workflows](/docs/guide/workflows/) first — the sections below assume you know what the replacements are and only cover what to change.

## Before you start: persisted state resets

The current release stores Flue schema **version 8**; the beta stored version 5. Pre-1.0 persisted schemas are **reset-only** — the runtime rejects an older database before any application code runs, and there is no in-place migration.

- If beta conversation state is disposable, plan a drained deployment: retire the old agents (on Cloudflare, with `deleted_classes` migrations) and create fresh ones. Application data that shares an agent's storage (a `base`/`wrap` DO extension, values written beside Flue's tables) is deleted with it — export anything you need first.
- If beta state must survive, export it through the beta application _before_ upgrading, and re-seed after.

Everything else in this guide can be staged; this one is a hard boundary.

## Build and dev commands

`flue build` and `flue dev` are removed. A Flue application is now a Vite project: add `vite`, `@flue/vite`, and `hono` as dependencies (and on Cloudflare, `@cloudflare/vite-plugin`) and author `vite.config.ts` — `flue()` must come **before** `cloudflare()`:

```ts title="vite.config.ts"
import { cloudflare } from '@cloudflare/vite-plugin'; // Cloudflare target only
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare()],
});
```

- `flue dev` — now `vite dev` (the dev server moves from port 3583 to Vite's 5173).
- `flue build` — now `vite build`; on Node, then `node dist/server.mjs` as before.
- Target selection via `--target` — now auto-detected from the plugin array, or set `target` in `flue.config.ts`.

Update `package.json` scripts and every CI pipeline that builds the project. On Cloudflare the plugin generates two inputs the Cloudflare plugin consumes — `.flue-vite/` (the Worker entry) and `.flue-vite.wrangler.jsonc` (your authored `wrangler.jsonc` merged with generated bindings). Add both to `.gitignore`.

If you have a `flue.config.ts`, two changes:

- `defineConfig` now comes from `@flue/runtime/config`; the `@flue/cli/config` subpath is gone.
- The `root` and `output` fields are retired — Vite owns both. Strict validation rejects them everywhere except `flue run`, which silently drops unknown keys — delete them.

`.env` loading also changed: `vite dev` loads Vite's standard `.env` files, and `flue run` loads `.env` (pass `--env` for an alternate). Built servers never load `.env`.

## Routing: the auto-router is gone

The beta's `flue()` router (`app.route('/', flue())` from `@flue/runtime/routing`, or the generated default app) no longer exists. `app.ts` is now **required**, and it mounts every route explicitly:

```ts title="src/app.ts (beta)"
import { flue } from '@flue/runtime/routing';
const app = new Hono();
app.use('/agents/*', requireUser);
app.route('/', flue()); // agents, workflows, channels — discovered and mounted
export default app;
```

```ts title="src/app.ts (now)"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Triage } from './agents/triage.ts';
import { channel } from './channels/slack.ts';

const app = new Hono();
app.use('/agents/*', requireUser);
app.route('/agents/triage', createAgentRouter(Triage)); // explicit, per agent
app.route('/channels/slack', channel.route()); // explicit, per channel
export default app;
```

- `createAgentRouter(fn)` is a pure router factory serving `POST /:id`, `GET|HEAD /:id`, `POST /:id/abort`, and `GET /:id/attachments/:attachmentId` relative to the mount. URL shapes are yours — keep the old `/agents/<name>` paths if deployed clients address them.
- **Registration comes from the [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive), not the mount.** A dispatch-only agent stays unmounted and still works; mounting registers nothing.
- The agent-module `export const route` and `export const attachments` conventions are deleted. Per-agent middleware becomes ordinary Hono middleware registered before the mount; attachment download exists on every mounted agent.
- The `POST /:id` body changed: `{ "message": "...", "images": [...] }` becomes a bare message object — `{ "message": { "kind": "user", "body": "..." } }` — with optional top-level `initialData` and `uid`. The `?wait` query is gone; clients follow the returned `streamUrl` or use the SDK's `wait()`.
- Workflow routes (`POST /workflows/<name>`, `/runs/<runId>`) are gone with workflows, as are the `runs` module export and `WorkflowRouteHandler`/`WorkflowRunsHandler` types.

## Defining an agent

The beta's async initializer returning a config bag becomes a **synchronous agent function** composing behavior with hooks, in a module marked by the `'use agent'` directive:

```ts title="src/agents/support.ts (beta)"
import { defineAgent } from '@flue/runtime';

export default defineAgent(async ({ id, env }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: `Help with ticket ${id}.`,
  tools: [lookupOrder],
  skills: [refundsSkill],
  subagents: [reviewerProfile],
  sandbox: bash(myFactory),
  cwd: '/workspace',
  durability: { maxAttempts: 5 },
}));
```

```ts title="src/agents/support.ts (now)"
'use agent';
import {
  type AgentProps,
  useModel,
  useSandbox,
  useSkill,
  useSubagent,
  useTool,
} from '@flue/runtime';

export function Support({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(myFactory, { cwd: '/workspace' });
  useTool(lookupOrder);
  useSkill(refundsSkill);
  useSubagent({ name: 'reviewer', description: '…', agent: Reviewer });
  return `Help with ticket ${id}.`;
}
Support.durability = { maxAttempts: 5 };
```

The agent **is** the exported function — there is no wrapper, no config bag, and no default export. Discovery no longer cares about the `src/agents/` directory: the build scans the source root for the `'use agent'` directive, and every exported capitalized function in a marked module is an agent. A converted module without the directive is silently not an agent.

Field-by-field:

- `model` — now [`useModel(model, options?)`](/docs/reference/agent-hooks-api/#usemodel): **required**, exactly once per render, root render only.
- `instructions` — now the agent function's return string; [`useInstruction()`](/docs/reference/agent-hooks-api/#useinstruction) appends more.
- `tools` — now [`useTool()`](/docs/reference/agent-hooks-api/#usetool) per tool.
- `skills` — now [`useSkill()`](/docs/reference/agent-hooks-api/#useskill) per skill.
- `subagents` (profiles) — now [`useSubagent({ name, description, agent, model?, thinkingLevel? })`](/docs/reference/agent-hooks-api/#usesubagent); the delegate is an agent function, not a profile. `defineAgentProfile` is removed; `defineSubagent()` defines delegates shared across agents.
- `thinkingLevel`, `compaction` — now `useModel(model, { thinkingLevel, compaction })`.
- `sandbox`, `cwd` — now [`useSandbox(factory, { cwd })`](/docs/reference/agent-hooks-api/#usesandbox): at most once per render; presence may be conditional.
- `durability` — now the `durability` static: `Support.durability = { maxAttempts: 5 }`. A static, not a hook, because the platform applies it when the function is not running; an environment-dependent policy goes in the assigned expression (`flag ? x : y`).
- `profile` — removed; compose with custom hooks (plain functions calling hooks) instead.
- `actions` — removed with Actions. Express reusable operations as tools ([`harness: true`](/docs/guide/tools/) for app-driven model work).
- `description` (config) — deleted, no replacement.
- initializer `ctx.id` — now `AgentProps`: the root agent function receives `{ id }`.
- initializer `ctx.env` — now platform imports (`import { env } from 'cloudflare:workers'`) or `process.env`; the initializer context is gone.
- `async` initializer — the agent function **must be synchronous**; async work moves into tools, lifecycle hooks (`useAgentStart`/`useAgentFinish`), or resource factories such as the sandbox factory's `createSessionEnv()`.

Rules that have no beta equivalent, because renders repeat:

- The agent function re-renders before every model turn. **Resources** (`useTool`, `useSkill`, `useSubagent`) may be conditional — changes are announced to the model as `resources` signals — and so may `useSandbox` (a presence flip swaps the environment at the next turn boundary, announced as an `environment` signal), `usePersistentState` (its storage is keyed by name), and the **event hooks** (`useAgentStart`, `useAgentFinish`, `useResponseStart`, `useResponseFinish` — each seam runs whatever the current render declares, at-least-once). The one invariant: `useDataWriter` names must be declared identically on every render.
- Identity is the exported function's name, or an `fn.agentName = '...'` **string-literal** static override; PascalCase and lower-kebab-case are both valid, and identities are unique per application. Renaming an agent function without an `agentName` pin is a storage-identity change; renaming the file changes nothing. The beta's filename-derived identities do not need to be preserved — beta storage cannot carry forward through the [schema reset](#before-you-start-persisted-state-resets) anyway — so pick good function names now and keep them stable.
- If the beta agent parsed setup facts out of its conversation `id` (order numbers, channel refs), move them to creation data: declare a schema with the `initialData` static, pass `initialData` at dispatch, and read it with [`useInitialData()`](/docs/reference/agent-hooks-api/#useinitialdata).

New capabilities you will likely reach for while migrating — durable per-instance state ([`usePersistentState`](/docs/reference/agent-hooks-api/#usepersistentstate)), creation data ([`useInitialData`](/docs/reference/agent-hooks-api/#useinitialdata) + the `initialData` schema static), the delivered-message cursor ([`useDelivery`](/docs/reference/agent-hooks-api/#usedelivery)), self-dispatch ([`useDispatchMessage`](/docs/reference/agent-hooks-api/#usedispatchmessage)), client-facing data parts ([`useDataWriter`](/docs/reference/agent-hooks-api/#usedatawriter)), lifecycle seams ([`useAgentStart`](/docs/reference/agent-hooks-api/#useagentstart)/[`useAgentFinish`](/docs/reference/agent-hooks-api/#useagentfinish)), and response metadata ([`useResponseStart`/`useResponseFinish`](/docs/reference/agent-hooks-api/#useresponsestart)).

## Tools

The tool contract keeps `defineTool({ name, description, input, output, run })`, with one rename and two new flags:

- **`run({ input })` → `run({ data })`.** The parsed-arguments field on `ToolContext` is now `data`; `signal` is unchanged, and `log` (a `FlueLogger`) and `toolCallId` are always present. The pre-beta `parameters`/`execute` markers still throw.
- **`harness: true`** replaces session plumbing: the tool receives `harness` (`harness.prompt()` for model calls in the tool's own scratch conversation, `harness.sandbox` for the environment). `harness.session()` and `FlueSession`/`FlueSessions` are gone — `prompt()` lives directly on the harness, and `session.task()` delegation is now the model-driven `task` tool over `useSubagent` declarations. The `task` tool's `agent` parameter is required, and an unnamed task no longer clones the parent's configuration — declare `useSubagent(GeneralSubagent)` for a blank fresh-context delegate (see [Subagents](/docs/guide/subagents/#the-general-purpose-delegate)).
- **`durable: true`** opts a tool into checkpointed execution: `run` receives `step`, side effects go through `step.do(name, fn)`, and recovery replays recorded step values instead of re-running them. This is the in-agent replacement for small workflow orchestration.

[MCP servers](/docs/guide/mcp/) are new in this release — `useMcpConnection(...)` mounts a remote server's tools; nothing migrates.

`harness.fs` is also gone: the harness exposes [`harness.sandbox`](/docs/reference/agent-api/#harnesssandbox), a `SessionEnv` carrying `exec`, the file verbs, `cwd`, and `resolvePath`. Adapters may not support every verb and may expose native accessors (for example Cloudflare Shell's `shellWorkspace(harness.sandbox)`).

## Skills and markdown imports

Import-attribute syntax (`with { type: 'skill' }` and friends) is **removed**; the specifier decides:

- An import that resolves to a **`SKILL.md`** packages the whole skill directory and returns a `SkillReference` for `useSkill()`.
- Any **other `.md`** import is plain markdown text (a string), inlined at build time. To make one a skill, pass it through `defineSkill({ name, description, instructions })` — `defineSkill` writes frontmatter itself, so the file stays plain markdown. (A `?skill` import query was never released; do not use one.)
- Vite-native queries (`?raw`, `?url`) keep their usual meanings.

Manual invocation (`session.skill(...)`) is gone with the session surface; steer activation by naming the skill in instructions or in `harness.prompt()` text.

## Sandboxes

- **There is no implicit environment.** The beta gave every agent an in-memory virtual sandbox by default; now an agent without `useSandbox()` has no filesystem and no `read`/`write`/`edit`/`bash`/`grep`/`glob` tools, and `harness.sandbox` throws. Agents that relied on the implicit workspace attach one explicitly — add `just-bash` to your dependencies and declare `useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })))`. Agents that never touched files need nothing.
- `sandbox:` and `cwd:` config become `useSandbox(factory, { cwd })`, as above.
- Create remote providers lazily inside the factory's `createSessionEnv(options)`, not at module top level — `options.id` carries the conversation id there, which is also how durable per-conversation workspaces work. The beta's eager `await Sandbox.create()` at module scope must move inside.
- The standard tool set is composable: a `SandboxFactory` may pass `tools: [createReadTool(), createBashTool(), ...]` to swap or drop the sandbox-backed set, and `bash(factory)` wraps a just-bash instance into the virtual sandbox.

See [Sandboxes](/docs/guide/sandboxes/).

## Workflows are removed

`defineWorkflow`, `invoke()`, `listRuns()`, `getRun()`, workflow HTTP routes, `client.workflows.*`, `useFlueWorkflow()`, the `src/workflows/` discovery directory, the Workflow API, and workflow run events are all gone. There is no framework job abstraction to migrate _to_ — pick the smallest replacement that preserves your semantics:

1. **A single model operation with a returned value** (the common beta workflow): an awaited handle. `init(agent, { id })` addresses an instance; `handle.dispatch(message)` delivers through the normal queue and resolves with a receipt at admission, and `handle.read(receipt)` waits for settlement and resolves with the reply (`text`, `data`, `metadata`, `submissionId`). A failed or aborted run rejects `read()` with `AgentRunError`.

   ```ts
   import { init } from '@flue/runtime';
   import { Summarizer } from './agents/summarizer.ts';

   const summarizer = init(Summarizer, { id: `summary-${caseId}` });
   const receipt = await summarizer.dispatch(text);
   const reply = await summarizer.read(receipt);
   return reply.data.summary;
   ```

   A `signal` on the beta workflow call aborted the run itself; on the handle, `read(receipt, { signal })` cancels only the local wait — the submission keeps running and spending. Carrying the option over mechanically converts a durable abort into a local cancel. When cancelling the read should also stop the run, call [`abort()`](/docs/reference/agent-api/#agenthandle).

2. **Checkpointed side-effect sequences inside an agent**: a `durable: true` tool with `step.do(...)`.

3. **Multi-step orchestration with its own durability, retries, and inspection** (what workflow runs gave you): an application-owned orchestrator. On Cloudflare, use a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) whose steps call the `init()` handle: one step calls `dispatch(...)`, with the recorded receipt standing in for that step's result, and a following step calls `read(receipt)`, with the recorded reply standing in for its own result on re-execution. Run inspection (`getRun()`) has no framework replacement: reconcile from your orchestrator's own state and from `submission_settled` observability events.

The retry policy that lived on the workflow moves to the agent's `durability` static. Scheduled workflows follow the same move: a cron trigger now dispatches a signal message to an agent (`dispatch(Agent, { id, message: { kind: 'signal', ... } })`) instead of calling `invoke()` — see [Schedules](/docs/guide/schedules/).

In standalone Node scripts (cron jobs, CI, tests), boot the runtime first with `start()` from `@flue/runtime/node`, passing agent functions (or `{ agent, name? }` entries); then `init()`/`dispatch()` work as they do in a server. See [Standalone scripts](/docs/guide/building-agents/#standalone-scripts). All of these replacement patterns are covered in depth in the [Workflows](/docs/guide/workflows/) guide.

## Dispatch and conditional sends

`dispatch(agent, request)` keeps its shape with three changes:

- The named-string form (`dispatch({ agent: 'name', ... })`) is removed — pass the agent function itself.
- The creation seed field is **`initialData`** (validated by the agent's `initialData` schema static at creation, read with `useInitialData()`; ignored on sends that continue an existing instance). If your beta app abused the first message body to carry setup facts, move them here.
- **`uid` send conditions**: omit to continue-or-create; pass a previous receipt's `uid` to continue only that incarnation (`AgentInstanceNotFoundError`/404 otherwise); pass `null` to create only (`AgentInstanceExistsError`/409 otherwise, carrying the existing uid). Conditions are checked at admission and create nothing on failure. `getAgentInstance(agent, id)` looks up `{ id, uid }` without sending.

A bare string is user-message shorthand everywhere a message is accepted. `dispatch()` remains fire-and-forget at durable admission — the top-level function and the `init()` handle's `dispatch()` share the same contract; `read(receipt)` is what awaits settlement, as shown above.

**The `dispatchId` → `submissionId` rename.** Pre-release builds used `dispatchId` for dispatch receipts and event correlation; the final vocabulary is one name. `DispatchReceipt.dispatchId` is now `submissionId`, `FlueEvent` carries no `dispatchId` field — `submissionId` alone identifies a submission's activity, dispatched or direct (see the [Events Reference](/docs/reference/events/#flueevent)) — and the telemetry adapters emit `flue.submission.id` instead of `flue.dispatch.id`. New submission ids are `sub_`-prefixed; ids are opaque — do not parse the prefix.

## Channels

Every channel connector package changed the same way:

- **Mount explicitly.** Channels are no longer auto-served from `src/channels/`. Each connector now exposes `channel.route()`; mount it in `app.ts` at the old auto-mount path (`app.route('/channels/slack', channel.route())`) so registered webhooks keep working.
- **`conversationKey` → `instanceId`.** `channel.conversationKey(ref)` is now `channel.instanceId(ref)` and `parseConversationKey()` is `parseInstanceId()`, across all connectors, with no aliases; error classes renamed to match (`Invalid<Channel>InstanceIdError`). Zendesk's `ticketKey`/`parseTicketKey` keep their names.
- Most connectors now pass structured facts as `initialData` at dispatch instead of encoding them in the id — prefer `useInitialData()` over id parsing in channel agents; `parseInstanceId()` remains as an escape hatch.

Hand-written channels build on the new `createChannelRouter(routes)` from `@flue/runtime` — see [Channels](/docs/guide/channels/).

## Database

- Ecosystem adapters now take your driver instead of a connection string: `postgres(process.env.DATABASE_URL!)` becomes `postgres({ query, transaction, close })` wrapping your own `pg` pool. The same runner pattern applies to libsql, mysql, mongodb, and redis; each [ecosystem database page](/docs/guide/database/) shows the wrapper.
- `db.ts` moved from `.flue/db.ts` to the source root (`src/db.ts`), matching the general source-root rule. Standalone `start()` scripts take `db:` directly and do not read `db.ts`.
- Custom adapters: `RunStore` and `EventStreamStore` are deleted, `AgentSubmissionStore` grew settlement and lease methods, and `@flue/runtime/test-utils` now ships contract test suites to verify an adapter against the new obligations.

## Providers

Flue's provider registration schema is gone; providers are now [Pi](https://pi.dev/docs/latest/providers)'s own objects, registered with `setProvider()`. `registerProvider()`, `registerApiProvider()`, `ProviderRegistrationError`, and the registration option bag are removed.

- `registerProvider('ollama', { api, baseUrl, ... })` — now `setProvider(createProvider({ id: 'ollama', auth, models, api }))` with Pi's `createProvider`. Models are declared as full `Model` objects (each carries its own `baseUrl` and metadata); there is no catalog hydration or zero-fill for custom providers. The [Ollama recipe](/docs/guide/models/#custom-providers) is the template.
- `registerProvider('anthropic', { baseUrl, apiKey })` (patch a built-in) — now register your own provider under the built-in's ID, reusing its catalog models: `models: anthropicProvider().getModels().map((m) => ({ ...m, baseUrl }))`. The [gateway recipe](/docs/guide/models/#custom-providers) shows the full shape.
- `apiKey` on a registration — now the provider's own `auth.apiKey.resolve()` (a fixed value, an env read via Pi's `envApiKeyAuth`, or a dynamic exchange). Environment-variable resolution for built-ins is unchanged.
- `contextWindow`/`maxTokens`/`reasoning`/`input` and the per-model `models` map — now fields on the `Model` objects your provider declares.
- `headers` — now `headers` on the `Model` objects, or returned from `auth.apiKey.resolve()`.
- `storeResponses` — removed; no replacement. Open an issue if you relied on OpenAI-hosted item persistence.
- `telemetry` overrides — removed; observability events report the fixed provider-ID normalization only.
- `registerApiProvider({ api, stream, streamSimple })` — now pass the `{ stream, streamSimple }` pair as `createProvider()`'s `api` field; the global wire-protocol registry is gone.
- `registerProvider('cloudflare', { api: 'cloudflare-ai-binding', binding, gateway })` — now `setProvider(cloudflareBindingProvider({ binding, gateway }))` from `@flue/runtime/cloudflare/workers-ai`. The generated Worker entry registers it when the `providers` config is omitted or lists `'cloudflare'`, and an `app.ts` registration still wins.
- In tests, Pi's compat `registerFauxProvider(...)` — now `fauxProvider(...)` from `@earendil-works/pi-ai` plus `setProvider(faux.provider)`; there is no `.unregister()`.

New in the same release: the [`providers` config](/docs/reference/provider-api/#the-providers-config) on the `flue()` plugin selects which providers ship in the build (`flue({ providers: ['anthropic'] })`); omitted means all, as before. The list is exhaustive — on the Cloudflare target it includes the Workers AI binding provider, so name `'cloudflare'` when you use `cloudflare/...` models.

## Observability

Run-scoped events are gone with workflows; agent activity is observed directly. Register `observe(...)` as before, and migrate event handling:

- `run_start` / `run_end` — now `agent_start` / `agent_end`.
- `runId` correlation — now `instanceId` (the agent instance) and `submissionId` (one submission, dispatched or direct).
- Polling `getRun()` for the outcome — now `submission_settled` events (the terminal outcome of every submission) plus your own orchestrator's state.
- Failed run inspection — now `operation` events with `isError`, carrying the failing operation kind.
- `createOpenTelemetryObserver()` from `@flue/opentelemetry` — now [`createOpenTelemetryInstrumentation()`](/docs/ecosystem/tooling/opentelemetry/), registered with `instrument(...)` instead of `observe(...)`; the `exportContent` option became the instrumentation-wide `content` policy, and the old custom model/tool content attributes are no longer emitted alongside the standard fields.

See the [Events Reference](/docs/reference/events/) for the full envelope (`v: 3`) and payload contract.

## Agent SDK

The beta's deployment-wide client is now **conversation-scoped**: construct one client per conversation URL — the agent's mount URL plus the conversation id. There is no `baseUrl`, no agent-name addressing, and no `client.agents`/`client.workflows`/`client.runs` namespaces.

```ts
// Beta
const client = createFlueClient({ baseUrl: '/api' });
await client.agents.send('support-assistant', ticketId, { message });
await client.agents.abort('support-assistant', ticketId);

// Now
const conversation = createFlueClient({ url: `/api/agents/support-assistant/${ticketId}` });
await conversation.send({ message, initialData });
await conversation.abort();
```

- The conversation client exposes `send` (202 admission; returns `uid` and `submissionId`), `wait(admission)`, `observe()`, `history()`, `abort()`, and `attachmentUrl()`.
- `wait()` now rejects with `FlueExecutionError` on failure or abort; error envelope codes changed (`agent_not_found` → `agent_instance_not_found`, plus `agent_instance_exists` for conditional sends).
- `abort()` aborts the **conversation's** in-flight and queued work — there is no per-submission abort — so shared conversations (an operator chat that also receives dispatched internal work) should account for that scope.
- Live updates default to SSE with long-poll fallback.

## React

`@flue/react` now exports only `useFlueAgent`. `FlueProvider` and `useFlueWorkflow` are removed.

```tsx
// Beta
<FlueProvider client={deploymentClient}>…</FlueProvider>;
const agent = useFlueAgent({ name: 'support-assistant', id });

// Now — pass the conversation URL, or a memoized conversation client
const agent = useFlueAgent({ url: `/api/agents/support-assistant/${id}` });
const agent = useFlueAgent({ client }); // useMemo the client — a new instance replaces the session
```

Messages remain Flue-owned parts-based values; new part kinds (`data-*` from `useDataWriter`, message `metadata` from the response hooks) should be narrowed, not assumed. `refresh()` and the dormant-when-`url`-omitted behavior carry over.

## Cloudflare deployments

- **`FlueRegistry` is gone.** The beta's deployment-wide registry DO indexed workflow runs; nothing replaces it. Append a `deleted_classes` migration for it, and for every `Flue<Name>Workflow` class.
- Generated classes are per-agent only: `export function Triage()` → class `FlueTriageAgent`, binding `FLUE_TRIAGE_AGENT` (one class per agent function; a file can carry several). Migration history stays user-authored — adding an agent is always the triple: the exported agent function in a `'use agent'` module, the mount (unless dispatch-only), and a `new_sqlite_classes` entry. Renames use `renamed_classes` — but remember the [schema reset](#before-you-start-persisted-state-resets): a beta-era database is rejected even under a renamed class, so beta agents are usually retired (`deleted_classes`) in favor of fresh identities.
- Your authored `wrangler.jsonc` is never modified; the build merges it into the generated, gitignored `.flue-vite.wrangler.jsonc`, and `vite build` writes the finalized config into `dist/` with a deploy redirect — deploy with plain `wrangler deploy` from the project root, no `--config` flag.
- `cloudflare.ts` moved from `.flue/cloudflare.ts` to `src/cloudflare.ts`. The generated entry exports every agent class plus your `app.ts` fetch handler; application-owned exports (your own DOs, Workflows, the `scheduled` handler) come from `cloudflare.ts`, and scheduled work starts with `dispatch()`, not `invoke()`.
- Update `run_worker_first` from the beta's `["/api/*", "/_flue/*"]` to cover your actual mounts, for example `["/api/*", "/agents/*", "/channels/*"]`.
- The minimum `compatibility_date` is `2026-04-01`, validated at build.

## CLI

`flue init`, `flue add`, `flue update`, and `flue docs` remain (`flue init` is now a full interactive project scaffold rather than a config-file writer). `flue dev` and `flue build` are removed (Vite owns both). `flue run` no longer talks to a built server; it executes one agent module in-process:

```bash
# Beta
flue run support --target node --input '{"ticket": 42}'
# Now
flue run src/agents/support.ts --message "Handle ticket 42." --id ticket-42
```

- Required: the module path and `-m/--message`. `--name` selects among multiple agents in one module.
- `--input` → `--data '<json>'` (creation data, validated by the `initialData` static).
- Gone with the HTTP form: `--server`, `--header`, `--target`, `--root`, `--output`, `--config`, and workflow names. To call a deployed server, use the SDK's conversation client instead.
- New: `--uid`/`--new` send conditions and `--json` (result envelope). Stdout is the reply only; logs go to stderr.
- `flue run` never loads `app.ts` — register providers in the agent module if you rely on `setProvider()` at app startup.

## Migration checklist

1. **Pins.** Replace `@flue/*@1.0.0-beta.x` with the current versions; add `vite`, `@flue/vite`, `hono`, and (Cloudflare) `@cloudflare/vite-plugin`. Drop beta-era patches and vendored builds — re-verify each patched behavior against the new runtime before porting anything.
2. **Build.** Author `vite.config.ts` (`flue()` before `cloudflare()`); move package scripts to `vite dev`/`vite build`; fix `flue.config.ts` (`@flue/runtime/config`, no `root`/`output`); gitignore the generated files.
3. **Routing.** Author explicit mounts in `app.ts`; delete `flue()` router usage; mount each channel's `route()`; decide which agents are dispatch-only.
4. **Agents.** Convert each initializer to an exported capitalized agent function in a `'use agent'` module: hooks for behavior, statics (`agentName`, `initialData`, `durability`) for the contract, `AgentProps` for the id, platform env instead of `ctx.env`. Convert profiles to `useSubagent` agent functions. Agents that used the implicit virtual sandbox declare one: `useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })))`.
5. **Tools.** Rename `run({ input })` to `run({ data })`; adopt `harness: true` where tools prompted sessions; consider `durable: true` for side-effect sequences.
6. **Skills.** Delete import attributes; let `SKILL.md` imports package themselves; wrap other markdown with `defineSkill` where needed.
7. **Workflows.** Replace each with the smallest fit: awaited `init()` handle, durable tool, or an application-owned orchestrator.
8. **Channels and database.** Rename `conversationKey`/`parseConversationKey` to `instanceId`/`parseInstanceId`; rewrite database adapters around your own driver; move `db.ts` to the source root.
9. **Providers.** Replace `registerProvider()`/`registerApiProvider()` calls with Pi's `createProvider()` + `setProvider()` (add `@earendil-works/pi-ai` to your dependencies); replace the Cloudflare binding registration with `cloudflareBindingProvider()` from `@flue/runtime/cloudflare/workers-ai`; optionally narrow the shipped providers with `flue({ providers: [...] })` (name `'cloudflare'` to keep Workers AI).
10. **Observability.** Migrate `run_*` handling to `agent_start`/`agent_end`/`submission_settled` and the `instanceId`/`submissionId` correlation fields.
11. **Clients.** Move SDK and React usage to conversation-scoped clients and `useFlueAgent({ url | client })`.
12. **Deployment.** Append `deleted_classes` for `FlueRegistry` and workflow classes; add `new_sqlite_classes` for new agents; plan the drained deployment for the schema reset.
13. **Verify.** Typecheck, tests, a production `vite build`, and a check of the built artifact (exports, merged wrangler config) before deploying.
