---
title: Agent API
description: The agent module contract and the programmatic surface around agents — agent functions, statics, dispatch(), init(), start(), HTTP routing, the harness, the defineTool/defineSkill/defineSubagent resource helpers, and signal narration.
lastReviewedAt: 2026-07-23
---

This page documents the agent module contract, every export of `@flue/runtime` (plus the `/node` and `/routing` subpaths) that addresses, runs, or serves an agent from the outside, and the `defineTool`/`defineSkill`/`defineSubagent` helpers that author the resources agents mount. The hooks an agent function calls while it renders — `useModel`, `useTool`, `usePersistentState`, and the event hooks — are documented in the [Agent Hooks API](/docs/reference/agent-hooks-api/).

Other parts of the `@flue/runtime` surface have their own reference pages:

- [Errors](/docs/reference/errors/) — error classes and transport categories.
- [Events](/docs/reference/events/) — `observe()`, `instrument()`, `FlueEvent`, and the observation types.
- [Provider API](/docs/reference/provider-api/) — the `providers` config, `setProvider()`, and `cloudflareBindingProvider()`.
- [Sandbox Adapter API](/docs/reference/sandbox-api/) — `SandboxFactory`, `SessionEnv`, `SandboxApi`, `bash()`, `createSandboxSessionEnv()`, and the per-tool factories (`createReadTool` and friends).
- [Data Persistence API](/docs/reference/data-persistence-api/) — `PersistenceAdapter` and the store contracts.
- [Streaming Protocol](/docs/reference/streaming-protocol/) — the conversation wire protocol behind `ConversationStreamChunk`.

## Agent functions

```ts
type AgentFunction<TProps = void> = TProps extends void
  ? () => string | undefined | void
  : (props: TProps) => string | undefined | void;

type Agent = AgentFunction<AgentProps> & AgentStatics;
```

An agent is a plain synchronous function. Hooks called in its body attach capabilities (model, tools, skills, state); the returned string is its instruction document. `Agent` is the addressable unit: every API on this page that takes an agent — `dispatch()`, `init()`, `getAgentInstance()`, `createAgentRouter()`, `start()` — takes the function value itself.

- The function must return synchronously. Returning a promise throws `[flue] Agent functions must be synchronous.` Async work belongs in tools, event-hook callbacks, and resource factories.
- The return value must be a string or `undefined`. Returning anything else throws. A body with no `return` statement (tools-only agents) is legal.
- The instruction document is composed in call order: the returned string first, then each [`useInstruction()`](/docs/reference/agent-hooks-api/#useinstruction) contribution, joined with blank lines. The author owns all formatting.
- The runtime re-renders the function before every model call. Values read from hooks are snapshots as of that render; see [Rendering and the rules of hooks](/docs/reference/agent-hooks-api/#rendering-and-the-rules-of-hooks).
- Renders never nest. An agent function that directly invokes another agent function throws `[flue] Re-entrant agent render.` Shared behavior composes through [custom hooks](/docs/reference/agent-hooks-api/#custom-hooks); delegation goes through [`useSubagent()`](/docs/reference/agent-hooks-api/#usesubagent).
- Declaring two tools, two skills, two subagents, or two state names with the same name in one render throws (a duplicate tool name throws `ToolNameConflictError`).

## `AgentProps`

```ts
interface AgentProps {
  id: string;
}
```

Props the runtime passes to the root agent function — its route data.

- `id` — this agent instance's id: the `:id` segment of the agent's conversation URL, the `id` of a `dispatch()`/`init()` call, or the `--id` passed to `flue run`. Constant for the instance's whole life.
- Only the root agent function receives props. A subagent's agent function is called with no arguments; close over values explicitly to share them.
- On a bare render with no instance behind it (direct renders in tests and tooling), reading `props.id` throws.
- When the id encodes several structured facts, pass them as `initialData` and read them with [`useInitialData()`](/docs/reference/agent-hooks-api/#useinitialdata) instead of parsing the id.

## The `'use agent'` directive

```ts
'use agent';

export function TriageAgent() {
  // ...
}
```

Registration marks a module, not a function: `'use agent'` is a plain string literal at the top of the file, before imports and any other statement. At build time, Flue scans the project for marked modules and registers **every exported function with a capitalized name** as an agent. One module may export several agents. Registration is what makes an agent addressable — `dispatch()` and `init()` resolve targets against the registered set — and is separate from HTTP exposure, which is an explicit [`createAgentRouter()`](#createagentrouter) mount.

The agent's **durable identity** is the slug that keys its conversation storage (and the Durable Object class on Cloudflare). It resolves, in order:

1. The build-stamped binding — the `'use agent'` transform captures the identity as a string literal at build time, so minification cannot corrupt it.
2. The [`agentName` static](#agent-statics).
3. The function's own `name` — safe in plugin-less contexts (`flue run`, unit tests, `start()` scripts) where no minifier runs.

- Identities must match `/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/` (exported as `AGENT_IDENTITY_PATTERN`): a PascalCase function name or a kebab-case override. In particular, no `:` and no leading digit. Invalid identities throw at registration.
- Duplicate identities across the registered set throw. Registering the same function value under two identities throws.
- `__flueBindAgentModule()` and the `AgentIdentityBinding` type are exported for the build transform's generated code. They are not public API; do not call them.

The directive is a build-time contract. Outside a built application, [`start()`](#start) registers agents explicitly.

## Agent statics

```ts
interface AgentStatics {
  agentName?: string;
  initialData?: v.GenericSchema;
  durability?: DurabilityConfig;
}
```

The parts of an agent's contract the platform reads **without running the function**. All are optional plain properties assigned after the declaration:

```ts
export function IssueTriage() {
  /* ... */
}
IssueTriage.agentName = 'issue-triage';
IssueTriage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
IssueTriage.durability = { maxAttempts: 5, timeoutMs: 7_200_000 };
```

- `agentName` — the durable identity override. Assign it to decouple storage identity from the source-level function name (renaming the function then needs no data migration). Must match `AGENT_IDENTITY_PATTERN`; an invalid value throws when the identity is resolved. In a `'use agent'` module the value must be a **string literal** — build targets derive durable identifiers from it before any user code runs.
- `initialData` — a [Valibot](https://valibot.dev) schema for instance-creation data. Validated exactly once, at the instance's first contact, synchronously before anything durable is admitted; a mismatch — including absence, unless the schema accepts `undefined` — rejects the creating send. The schema-parsed output is what gets recorded and what [`useInitialData()`](/docs/reference/agent-hooks-api/#useinitialdata) returns. Without a schema, whatever the creator sent is recorded untyped.
- `durability` — the submission retry policy (below). A static rather than a hook because the platform applies it while the function is _not_ running, including after a crash in the agent's own render. Unlike `agentName`, the value need not be a literal — express environment-dependent policy in the assigned expression: `Fn.durability = process.env.CI ? { timeoutMs: 60_000 } : { timeoutMs: 3_600_000 }`.

## `DurabilityConfig`

```ts
interface DurabilityConfig {
  maxAttempts?: number;
  timeoutMs?: number;
}
```

- `maxAttempts` — maximum total attempts before a submission is terminalized as failed (`SubmissionRetryExhaustedError` settlement). The initial run counts as the first attempt; each interruption that re-runs the submission consumes another. Positive integer. Default `10`.
- `timeoutMs` — maximum wall-clock milliseconds for a single submission, measured from the first attempt's start; a submission that exceeds it is aborted and settled failed (`SubmissionTimeoutError`). Turn-boundary joins and `useAgentFinish` continuations do not extend it. The deadline is checked cooperatively — before each turn and before recovery work, not preemptively during provider calls — so a hung provider call can outlive it; that case is covered by the attempt budget, not this check. Positive integer. Default `3_600_000` (one hour).
- Unknown fields throw at validation. Absent the static, the store defaults above apply.

See [Durability](/docs/guide/durability/) for the recovery model.

## `DeliveredMessage`

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };

type DeliveredMessageInput = string | DeliveredMessage;

type DeliveredAttachment = PromptImage & { filename?: string };
```

The single unified input shape for every delivery surface: `dispatch()`, the `init()` handle, [`useDispatchMessage()`](/docs/reference/agent-hooks-api/#usedispatchmessage), and a direct HTTP prompt (whose wire body is this shape verbatim). Everywhere a `DeliveredMessageInput` is accepted, a bare string is shorthand for `{ kind: 'user', body }`.

- `kind: 'user'` — a direct user talking to the assistant. Produces a canonical `user_message` record and projects with `purpose: 'user'` in the conversation. `attachments` carries images for vision-capable models: `{ type: 'image', data, mimeType, filename? }`, where `data` is base64 and capped at 14 MiB of base64 characters per attachment (`14 * 1024 * 1024`). Images are the only supported attachment.
- `kind: 'signal'` — everything beyond a direct 1:1 exchange, and the right shape for most channels: each participant's or system's activity, with sender identity and structured metadata in `attributes` and the content in `body`. Signals render into model context as an XML-tagged block, not a chat turn.
  - `type` — caller-defined event type, e.g. `'slack.message'`. Non-empty. [Framework-reserved types](#dynamic-resources) are rejected at admission on every transport.
  - `body` — a plain string. JSON-stringify structured payloads yourself.
  - `attributes` — a string-to-string map, rendered alongside the body.
  - `tagName` — overrides the XML tag the signal renders as; defaults to `signal`. Because it is rendered unescaped, it must be a valid XML name: letters, digits, `_`, `-`, `.`, not starting with a digit, `-`, or `.`.
- A malformed message throws the stable `InvalidRequestError` (`invalid_request`) — the same validation on every transport. See [Errors](/docs/reference/errors/).
- Agent code reads the delivered message with [`useDelivery()`](/docs/reference/agent-hooks-api/#usedelivery).

## `dispatch()`

```ts
function dispatch(agent: Agent, request: AgentDispatchRequest): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  message: DeliveredMessageInput;
  initialData?: unknown;
  uid?: string | null;
}

interface DispatchReceipt {
  submissionId: string;
  acceptedAt: string;
  uid: string;
}
```

Fire-and-forget delivery of one message to one agent instance. Resolves once the runtime has admitted and queued the input — it does not wait for model processing or a reply. To read the settled reply, use the [`init()` handle](#init) and pass the receipt to its `read()`.

Request fields:

- `id` — the target instance id. Required, non-empty. The instance is created on first contact; there is no separate create step.
- `message` — the delivered message. Snapshotted at admission time.
- `initialData` — instance-creation data, consulted **only when this send creates the instance**: validated against the agent's `initialData` schema static (when declared) and recorded once, readable forever via `useInitialData()`. Silently ignored when the send continues an existing instance — pair with `uid: null` to error instead. Cannot be combined with a string `uid`; the combination is rejected at validation, before anything durable happens (the condition forbids creation, so the seed could never apply).
- `uid` — the send condition; see [Conditional sends](#conditional-sends).

Receipt fields:

- `submissionId` — generated identifier for this accepted delivery.
- `acceptedAt` — ISO timestamp assigned when admission began.
- `uid` — the contacted incarnation's uid: minted at birth when this send created the instance, echoed when it continued one.

Behavior and errors:

- The target must be a registered agent of the current application (a `'use agent'` export, or a `start()` entry). An unregistered function rejects; a non-function first argument rejects with `InvalidRequestError`.
- Calling `dispatch()` before a runtime is configured rejects — inside a Flue-built server the runtime is configured automatically; standalone scripts call [`start()`](#start) first.
- A missing `id` rejects with a human-readable `Error`; a malformed `message` throws `InvalidRequestError`.
- A dispatch to a busy instance joins the live response at the next turn boundary; a dispatch to an idle instance wakes a new response. Deliveries that miss the live response run as their own submission from the durable queue — they are never lost. Dispatched activity belongs to the continuing instance and shares one accepted order with direct HTTP prompts to it.
- **Target differences.** On Cloudflare, dispatch durably admits work to the target agent's Durable Object and may retry processing after an interruption. On Node, delivery durability follows the configured [persistence adapter](/docs/reference/data-persistence-api/): the default in-memory store is process-lifetime only, while a durable adapter keeps admitted dispatches across restarts and reconciles them on the replacement process. On both targets processing is at-least-once — design external side effects to be idempotent.

## Conditional sends

Sends are conditional requests, with the instance `uid` playing the ETag:

- `uid` omitted — unconditional: continues the instance, or creates it.
- `uid: '<string>'` — continue only the incarnation with this uid. A missing instance or mismatched uid rejects at admission with `AgentInstanceNotFoundError` (`agent_instance_not_found`, HTTP `404`); nothing durable happens. Cannot be combined with `initialData`.
- `uid: null` — create only when no instance exists. An existing instance rejects at admission with `AgentInstanceExistsError` (`agent_instance_exists`, HTTP `409`).

`AgentInstanceExistsError` carries the existing instance's uid on its `.uid` property and in its error `details` — deliberately: the uid is accident prevention for the caller, not a security mechanism (access control belongs in [middleware at the mount](/docs/guide/routing/#protecting-your-agents)), so a caller can recover from the `409` and continue the existing instance without a separate lookup. Both error classes are importable from `@flue/runtime`; see [Errors](/docs/reference/errors/).

The uid to condition on comes from a previous receipt or reply, or from [`getAgentInstance()`](#getagentinstance). The direct-HTTP wire carries the same condition as a reserved `uid` sibling on the message body, and the `202` admission body echoes `uid` alongside `streamUrl`/`offset`/`submissionId`; see [Routing](/docs/guide/routing/#sending-a-message).

## `init()`

```ts
function init(agent: Agent, options?: InitOptions): AgentInstanceHandle;

interface InitOptions {
  id?: string;
  uid?: string | null;
}

interface AgentInstanceHandle {
  readonly id: string;
  dispatch(request: string | AgentHandleDispatchRequest): Promise<DispatchReceipt>;
  read(target: string | DispatchReceipt, options?: AgentReadOptions): Promise<AgentReply>;
  abort(): Promise<void>;
}

type AgentHandleDispatchRequest = Omit<AgentDispatchRequest, 'id' | 'uid'>;
// = { message: DeliveredMessageInput; initialData?: unknown }

interface AgentReadOptions {
  onEvent?: (chunk: ConversationStreamChunk) => void;
  signal?: AbortSignal;
}
```

The programmatic client for one agent instance. The handle is an _address_, not a resource: `init()` itself creates nothing and performs no I/O — the instance is created on first contact exactly as it would be for any other delivery, and the runtime is resolved when the handle is used, so `init()` at module scope is safe.

`init()` options:

- `id` — the instance address. Omit to mint a fresh unique id (a throwaway instance for this run); pass a stable id to address an instance later sends can find again. An empty or non-string id throws; a non-function `agent` throws `InvalidRequestError`.
- `uid` — the send condition for the handle's **first** contact, with [the same semantics as `dispatch()`](#conditional-sends). After a send's receipt, the handle pins the incarnation it contacted and later sends continue it.

`handle.dispatch()` delivers one message through the same dispatch queue as every other transport — every hook fires exactly as it does elsewhere — and resolves at admission with the durable [`DispatchReceipt`](#dispatch), the same contract as the top-level `dispatch()`. Its payload is the top-level request minus the `id`/`uid` the handle owns; a bare string is shorthand for `{ message }`.

- A payload that is not a string and carries no `message` property throws. A payload carrying `id` or `uid` throws — pass those to `init(agent, { id, uid })`.
- Admission-time conditions surface here: a failed [send condition](#conditional-sends) rejects with `AgentInstanceNotFoundError` or `AgentInstanceExistsError` before anything durable happens.

`handle.read()` awaits one submission's settlement and resolves with its [`AgentReply`](#agentreply). The target is a dispatch receipt, or the bare submission id — for a dispatch, its `submissionId`; the receipt form also carries the contacted incarnation's `uid` onto the reply.

- **Re-attachable.** Settlement and reply are durable conversation records, so a read works from any process at any later time: a submission that settled long ago resolves immediately, and reading the same submission again returns the same reply. A receipt persisted across a crash — say, as a workflow step's durable result — is all a retry needs; nothing in memory is load-bearing between `dispatch()` and `read()`.
- Concurrent deliveries to one instance serialize, or join a live response at a turn boundary; a delivery that joined reads the coalesced reply that answered it.
- Rejects with [`AgentRunError`](#agentrunerror) when the submission settles `failed` or `aborted`.
- `onEvent` receives every projected conversation chunk as it is durably recorded — the same [`ConversationStreamChunk`](/docs/reference/streaming-protocol/) projection the Flue Agent SDK's updates view reads.
- `signal` stops the read: the call rejects with the signal's reason. Cancelling a read is purely local — the submission keeps running and stays readable. To durably stop the agent's work, call `abort()`.
- A read addressed to an instance that does not exist rejects with [`AgentInstanceNotFoundError`](/docs/reference/errors/#agentinstancenotfounderror) on every target — a read waits for settlement, and an instance that was never contacted has nothing to settle. On an existing instance, an unsignalled read waits indefinitely for settlement, which the runtime's recovery invariants guarantee for every admitted submission; a submission id that never existed there is a programming error the read cannot detect — ids come from receipts.
- Inside a tool, reading a submission dispatched to the agent that is currently running the tool deadlocks by design: the delivery joins the tool's own live response, which cannot settle while the tool is still executing. A tool never needs it — the [harness](#harness) is the tool's own model surface, with its own scratch conversation; handles inside tools are for _other_ instances.

`handle.abort()` requests a **durable** abort of the instance's work — the running head and every queued submission behind it. It resolves once the intent is recorded; the distinct `aborted` settlement lands asynchronously, where a live `read()` observes it and rejects with `AgentRunError` outcome `'aborted'`.

All three verbs work anywhere the process has a configured Flue runtime: inside a Flue server (for example a cron callback in `app.ts`), in a standalone script after [`start()`](#start), under `flue run`, and in a deployed Cloudflare Worker — including Workflow steps, where the receipt and the settled reply each become a step's durable result. Used before any runtime is configured, the call rejects with the same configuration error as `dispatch()`.

## `AgentReply`

```ts
interface AgentReply {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
  uid?: string;
  submissionId: string;
}
```

- `text` — the final assistant text produced by the submission; `''` when none.
- `data` — the named client data parts written during the response ([`useDataWriter`](/docs/reference/agent-hooks-api/#usedatawriter)), keyed by part name, each an array of writes in order.
- `metadata` — agent-authored response metadata ([`useResponseStart`/`useResponseFinish`](/docs/reference/agent-hooks-api/#useresponsestart)), when present.
- `uid` — the contacted incarnation's uid (present when known; minted when this send created the instance).
- `submissionId` — the settled submission's id.

## `AgentRunError`

```ts
class AgentRunError extends Error {
  readonly outcome: 'failed' | 'aborted';
  readonly submissionId: string;
}
```

The rejection of a `read()` whose submission settled `failed` or `aborted`. The settlement's underlying error, when one was recorded, is attached as `cause`.

## `getAgentInstance()`

```ts
function getAgentInstance(agent: Agent, id: string): Promise<AgentInstanceInfo | null>;

interface AgentInstanceInfo {
  id: string;
  uid?: string;
}
```

Look up an agent instance by id: `null` when no instance exists, else its info, including the uid usable as a [send condition](#conditional-sends). `uid` is absent only while the instance's birth record has not yet landed (mid-materialization).

Most callers never need this — unconditional sends work without a uid, a creating send returns the fresh uid on its receipt, and a failed `uid: null` condition hands the existing uid back in its error details. Reach for it when code that did not create the instance wants to condition a send without attempting one first. The same registration, runtime-configuration, and argument-validation errors as `dispatch()` apply.

## `start()`

```ts
import { start } from '@flue/runtime/node';

function start(options: StartOptions): Promise<Flue>;

interface StartOptions {
  agents: readonly StartAgentEntry[];
  db?: PersistenceAdapter;
  env?: Record<string, string | undefined>;
  providers?: readonly Provider[];
}

type StartAgentEntry = Agent | StartAgentConfig;

interface StartAgentConfig {
  agent: Agent;
  name?: string;
}

interface Flue {
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

The Node bootstrap for running Flue outside a generated server entry — standalone scripts and test suites. It mirrors what a built server does at boot (agent registration, persistence, the durable submission coordinator) with no HTTP surface. After `start()` resolves, `init()`, `dispatch()`, and `getAgentInstance()` work exactly as they do inside a server.

- `agents` — the agents this runtime serves. Required, non-empty. Each entry is an agent function, or `{ agent, name }` when an identity override is needed (inline or anonymous functions in tests). Identity resolves from the entry's `name`, else the agent's own identity (`agentName` static, else function name) — never positionally, so reordering the array cannot reassign conversations. An anonymous function with no `agentName` and no `name` throws.
- `db` — persistence. Defaults to in-memory SQLite (process lifetime — nothing survives exit). Pass an adapter, such as [`sqlite('./run.db')`](/docs/guide/node-target/#sqlite) from `@flue/runtime/node`, to persist conversations across runs. See [Data Persistence API](/docs/reference/data-persistence-api/) for the adapter contract.
- `env` — the runtime environment (provider credentials and other bindings). Defaults to `process.env`.
- `providers` — the [Pi providers](/docs/reference/provider-api/) this runtime registers, replacing the default set. Omitted registers every Pi built-in, the same as `flue run`; an empty array registers none. Pass built-in factories, `createProvider(...)` customs, or a faux provider's `.provider` in tests:

  ```ts
  import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

  await start({
    agents: [Reporter],
    providers: [anthropicProvider()], // only anthropic/* specifiers resolve
  });
  ```

  Omitted, the default registration skips any ID already registered, so a `setProvider()` call made before `start()` overrides a same-ID built-in regardless of ordering. Given explicitly, `providers` registers unconditionally — an entry here overwrites a same-ID provider set before `start()`, since `setProvider()` always replaces on ID.

- Returns a `Flue` handle. `stop()` drains in-flight work, then disconnects persistence; the async-dispose symbol makes `await using flue = await start(...)` clean up automatically.
- One process holds at most one Flue runtime. `start()` throws when a runtime is already configured — inside a Flue server, call `init()`/`dispatch()` directly.

`@flue/runtime/node` also exports the `local()` sandbox factory and the `sqlite()` persistence adapter; both are documented in the [Node.js target guide's reference section](/docs/guide/node-target/#reference).

## `createAgentRouter()`

```ts
import { createAgentRouter } from '@flue/runtime/routing';

function createAgentRouter(agent: Agent): Hono;
```

Build the mountable [Hono](https://hono.dev/) sub-app serving one agent's HTTP surface. Mount it in the authored `app.ts` route map: `app.route('/agents/support', createAgentRouter(Support))`. Routes, relative to the mount point:

- `POST /:id` — send a prompt. The body is a [`DeliveredMessage`](#deliveredmessage) (optionally carrying top-level `initialData` and `uid` siblings); responds `202` on admission.
- `GET | HEAD /:id` — conversation stream read (the [streaming protocol](/docs/reference/streaming-protocol/)).
- `POST /:id/abort` — abort all in-flight and queued work for the instance.
- `GET /:id/attachments/:attachmentId` — attachment byte download.

Contract:

- Pure factory: no side effects, no options; call it any number of times and mount the result at any path. The mount path is routing only — conversations are keyed by the agent's durable identity, never by URL.
- Handlers resolve the runtime at request time, so creating the router before bootstrap registration completes is fine; a request served with no configured runtime errors.
- Throws at creation when the agent's identity cannot be resolved (an anonymous function with no `agentName` static) or is invalid.
- Unmatched methods on known paths render the canonical `405` envelope (`MethodNotAllowedError`); errors render through the [public transport error](/docs/reference/errors/) envelope.
- The router carries no authentication. Mounting is the exposure decision; compose auth and other middleware in the host app (`app.use('/agents/support/*', auth)`). See [Routing](/docs/guide/routing/#protecting-your-agents).
- The returned app exposes `.fetch`, so it also mounts in any fetch-based server framework.

Channels have the parallel factory `createChannelRouter(routes)` (exported from `@flue/runtime`), which serves a channel package's declarative `routes` array (`ChannelRouteDefinition[]`) the same way — channel packages wrap it as `channel.route()`. See [Channels](/docs/guide/channels/#mounting).

## `Fetchable`

```ts
import type { Fetchable } from '@flue/runtime/routing';

interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

The structural contract for the default export of an authored `app.ts` entry. Any object exposing a compatible `fetch()` satisfies it, including a `new Hono()` instance. On Cloudflare, `env` contains bindings and `ctx` is the `ExecutionContext`; on Node, `env` contains Hono's Node adapter bindings and `ctx` is `undefined`.

## Harness

```ts
interface FlueHarness {
  readonly name: string;
  prompt<S extends v.GenericSchema>(
    text: string,
    options: PromptOptions<S> & { result: S },
  ): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
  prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
  compact(): Promise<void>;
  readonly sandbox: SessionEnv;
}
```

The initialized agent environment owned by a runtime runner — the surface handed to a [`harness: true` tool](#definetool)'s `run` and to the [`useAgentStart`](/docs/reference/agent-hooks-api/#useagentstart)/[`useAgentFinish`](/docs/reference/agent-hooks-api/#useagentfinish) contexts. There is no way to construct one directly; a harness only exists inside an agent session, scoped to the invocation that received it.

## `harness.prompt()`

Runs a model operation in the harness's own scratch conversation — separate from the agent's public conversation, never shown to clients. Repeated calls within one harness continue that conversation (one active operation at a time), so a later prompt sees what earlier calls established. The conversation can delegate to the agent's declared [subagents](/docs/guide/subagents/) via the `task` tool. Harness invocations count against the delegation-depth cap, and child conversations they open are retained on the parent conversation for inspection.

Pass `options.result` (a Valibot schema) to require validated structured data: the model must call a framework-injected `finish` tool whose arguments validate against the schema, and the call resolves with `PromptResultResponse` instead of freeform text. When the model gives up or exhausts its follow-up attempts, the call rejects with [`ResultUnavailableError`](/docs/reference/errors/#resultunavailableerror).

```ts
interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
  result?: S;
  tools?: ToolDefinition[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  images?: PromptImage[];
}
```

- `result` — require validated structured data and resolve with `response.data`.
- `tools` — additional model-callable tools for this operation only.
- `model` — model specifier override (`'provider-id/model-id'`) for this operation. Defaults to the agent's `useModel` declaration.
- `thinkingLevel` — reasoning-effort override for this call. See [`ThinkingLevel`](/docs/reference/agent-hooks-api/#usemodel).
- `signal` — external abort signal, merged with the handle's own.
- `images` — inline images attached to the operation's user message (`PromptImage` re-exports pi-ai's `ImageContent`: `{ type: 'image', data, mimeType }`). Requires a vision-capable model.

```ts
interface PromptResponse {
  text: string;
  usage: PromptUsage;
  model: PromptModel;
}

interface PromptResultResponse<T> {
  data: T;
  usage: PromptUsage;
  model: PromptModel;
}

interface PromptModel {
  provider: string;
  id: string;
}

interface PromptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

`PromptUsage` aggregates every LLM call the operation dispatched: each assistant turn, result-extraction retries, and any compaction summarization the call triggered. `cost` is computed from the model's per-million-token rate table; for the built-in registry the rates mirror published provider pricing (USD for the major commercial providers), while custom-registered models may use other units. `PromptModel` names the model selected for the operation's primary turn. Operation failures beyond aborts reject with typed `FlueError` subclasses (for example `SessionBusyError`); see [Errors](/docs/reference/errors/).

## `CallHandle`

```ts
interface CallHandle<T> extends Promise<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
```

The awaitable handle `prompt()` returns. Aborting — via `abort()` or an `options.signal` — rejects the awaited value with a standard `AbortError` (`DOMException`). `signal` fires on abort from either source, so tools passed to the call can observe cancellation. `harness.sandbox.exec()` is cancelled the same way — pass its `options.signal` — since it resolves a plain `Promise`, not a `CallHandle`.

## `harness.compact()`

Triggers compaction of the harness conversation immediately. Resolves as a no-op when there is nothing to compact; rejects when summarization fails or is aborted, and with `SessionBusyError` when another operation is in flight on the conversation. This compacts the harness's scratch conversation — the agent's main conversation compacts automatically per its [`CompactionConfig`](/docs/reference/agent-hooks-api/#compactionconfig).

## `harness.sandbox`

The agent's environment itself: the live `SessionEnv` resolved from the agent's [`useSandbox()`](/docs/reference/agent-hooks-api/#usesandbox) declaration. One object carries the whole surface — `exec()`, the file verbs (`readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`), `cwd`, and `resolvePath()`. Accessing it in an agent that declared no sandbox throws `[flue] This agent has no sandbox. ...` — tools that may run in sandbox-less agents should not touch it. The full `SessionEnv` contract is documented in the [Sandbox Adapter API](/docs/reference/sandbox-api/).

- Operations on it are never recorded in a conversation. The model has its own tools for filesystem work it should reason about; `harness.sandbox` is for plumbing the model shouldn't see.
- `writeFile` creates missing parent directories in every sandbox mode.
- Relative paths resolve against the agent's cwd (`useSandbox(factory, { cwd })` when set, else the adapter default); use absolute paths for portability across adapters. `resolvePath()` resolves a relative path against `cwd` without touching the filesystem.
- Sandboxes are heterogeneous: an adapter may not support every generic verb (it throws where it cannot — the Cloudflare Shell adapter's `exec()` throws, since its durable Workspace has no shell) and may enrich the returned object with its native surface. Adapter packages ship runtime-checked accessors that narrow to that surface, such as Cloudflare Shell's `shellWorkspace(harness.sandbox)`.
- It is a live getter, not a snapshot: a [conditional `useSandbox()`](/docs/guide/sandboxes/#conditional-attachment) may swap the environment at a turn boundary, and this property follows. Do not cache the returned reference across turn boundaries if the agent swaps environments.

## `defineTool()`

```ts
function defineTool<...>(options: {
  name: string;
  description: string;
  input?: ToolInputSchema;   // Valibot schema; top-level object
  output?: ToolOutputSchema; // Valibot schema
  harness?: boolean;
  durable?: boolean;
  run(context: ToolContext<...>): ToolRunResult | Promise<ToolRunResult>;
}): ToolDefinition;
```

A typing and validation helper: it validates the definition and returns it frozen, so bad definitions fail at module load instead of first render. Also importable from the lighter `@flue/runtime/tool` entry for tool-only modules. Agents mount the returned value per render with [`useTool()`](/docs/reference/agent-hooks-api/#usetool).

- `name`, `description` — required non-empty strings. The description is the model-facing catalog line.
- `input` — a Valibot schema for the call's arguments. Must be a top-level object schema (the model sends a JSON object); anything else throws. When present, the parsed output arrives as `context.data`, typed by inference. When absent, the tool receives no `data` property and callers' arguments are ignored.
- `output` — a Valibot schema for the return value. When present, the runtime parses the returned value through it before recording; a mismatch throws `ToolOutputValidationError`, and a schema producing `undefined` throws `ToolOutputSerializationError`.
- `harness`, `durable` — capability flags, detailed below. Must be booleans when present.
- `run` — the implementation. May be async. Its return value must be JSON-serializable and is snapshotted as JSON-compatible data, then JSON-stringified for the model; non-serializable output throws `ToolOutputSerializationError`. Returning `undefined` is allowed only when no `output` schema is declared, and reaches the model as `null`. Throwing inside `run` records a tool error the model sees; it does not fail the submission.
- Arguments that fail the `input` schema throw `ToolInputValidationError` before `run` is invoked; the model receives the validation failure as the tool result and may retry.

Error classes are documented in [Errors](/docs/reference/errors/). For teaching material see the [Tools guide](/docs/guide/tools/).

**`ToolContext`** — the context passed to a tool's `run`:

```ts
type ToolContext<Input, Harness, Durable> = {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
} & {
  readonly data: v.InferOutput<Input>; // when `input` is declared
} & {
  readonly harness: FlueHarness; // when `harness: true`
} & {
  readonly step: ToolStep; // when `durable: true`
};

interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

- `toolCallId` — the id of the tool call being executed; the same id carried by the call's `tool_start`/`tool` events and its tool-result message, so durable side effects and observers can correlate by id. Synthesized in standalone runs with no model turn behind them.
- `signal` — the call's abort signal.
- `log` — progress logging for long-running tools. Lines are emitted into the conversation stream as `log` events attributed to this call; they are not part of the tool result and the model never sees them.
- `data` — the call's arguments, parsed by the `input` schema. Present only when `input` is declared.
- `harness` — the agent's runtime surface. Present only for `harness: true` tools. See [Harness](#harness).
- `step` — the durable-step surface (`ToolStep`, below). Present only for `durable: true` tools.

The helper types `ToolInput<TTool>` and `ToolOutput<TTool>` extract a tool's inferred argument and output types from its definition.

**Tool flags.**

- `harness: true` — `run` receives `harness`, the one interface to the agent's environment (`harness.sandbox`) and to models (`harness.prompt()`). Harness invocations are scoped to the tool call, count against the delegation-depth cap, and retain any child conversations they open. Harness tools only run inside an agent session, never standalone. Tools without the flag are pure functions of their data and cannot reach the runtime.
- `durable: true` — `run` receives `step`, and every side effect in the run is expected to go through `step.do(...)`. In exchange, an interrupted call is re-executed on recovery — completed steps replay their recorded values instead of running again — rather than being settled with an unknown-outcome error like ordinary tools. See [Durable tools and `step.do`](/docs/guide/durability/#durable-tools-and-stepdo).

The flags compose: a `durable: true, harness: true` tool receives both `step` and `harness` (wrap `harness.prompt(...)` in a step to avoid re-prompting on recovery).

**`ToolStep`** — the durable-step surface a `durable: true` tool receives:

```ts
interface ToolStep {
  do<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}
```

- `do(name, fn)` runs `fn` once per `name` for this tool call. The returned value is durably recorded before `do` resolves; a re-execution of the same tool call returns the recorded value without invoking `fn`.
- Exactly-once-recorded, at-least-once-executed: a crash between `fn` completing and the record landing re-executes `fn` on recovery. Make each step idempotent.
- Values must be JSON-serializable and should stay small — store large artifacts in the sandbox and record a pointer. Non-serializable values throw.
- Names identify the logical work: derive them deterministically (`` `upsert:${id}` ``). A non-empty string is required, and reusing a name within one call throws.
- Outside an agent session there is no durability — testing a durable tool's `run` directly means supplying your own `step` stub.

## `defineSkill()`

```ts
function defineSkill(definition: SkillDefinition): SkillDefinition;
```

Declare an inline skill in code. A typing and validation helper in the `defineTool()` mold: it validates the definition and returns it frozen — no packaging happens here. The runtime packages the definition into the same shape a `SKILL.md` import produces lazily, the first time the skill is needed; `defineSkill` writes the frontmatter itself, so `instructions` stays plain markdown. Invalid definitions throw `SkillDefinitionValidationError` with field-level issues, at module load. Agents mount the result with [`useSkill()`](/docs/reference/agent-hooks-api/#useskill).

## `SkillDefinition`

```ts
interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}
```

Equivalent to a skill directory: `instructions` is the `SKILL.md` body, and `files` carries supporting resources exactly as a directory import would.

- `name` — lowercase ASCII letters, numbers, and single hyphens only; at most 64 characters. Required.
- `description` — the catalog line: what the skill does and when to use it. At most 1024 characters. Required.
- `instructions` — the skill's content, loaded on activation. Required, non-empty — a skill is its content, so a definition with no instructions is rejected rather than mounted as an empty catalog line.
- `license`, `compatibility` — optional strings recorded in the packaged frontmatter (`compatibility` at most 500 characters).
- `metadata` — a string-to-string map recorded in frontmatter.
- `allowedTools` — space-separated pre-approved tools (experimental in the Agent Skills spec).
- `files` — supporting resources keyed by path relative to the skill root. Paths must be safe relative paths (no leading `/`, no `.`/`..` segments, no backslashes) and must not be `SKILL.md` itself. Content is a string or `Uint8Array`.

## `defineSubagent()`

```ts
function defineSubagent(definition: SubagentDefinition): SubagentDefinition;
```

Validates the definition and returns it frozen, so bad definitions fail at module load instead of first render. The returned object is the exportable unit — define a delegate once, mount it from any agent with [`useSubagent(...)`](/docs/reference/agent-hooks-api/#usesubagent). Per-mount overrides spread cleanly: `useSubagent({ ...issueClassifier, model: 'anthropic/claude-haiku-4-5' })`.

## `SubagentDefinition`

```ts
interface SubagentDefinition {
  name: string;
  description: string;
  agent: AgentFunction;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}
```

- `name` — the catalog name the model uses to select this delegate on the `task` tool. Required, non-empty.
- `description` — the catalog line; how the model decides when to delegate. Required, non-empty.
- `agent` — the agent function defining the delegate's whole world. Required.
- `model` — model specifier override. Inherits the parent turn's model when omitted.
- `thinkingLevel` — reasoning-effort override. Inherits when omitted.

## `GeneralSubagent`

```ts
const GeneralSubagent: SubagentDefinition;
```

A blank general-purpose delegate, ready to declare with `useSubagent(GeneralSubagent)`. Its agent function is deliberately empty: the child gets the shared environment's tools, the filesystem context discovered from its cwd, and the parent's model — none of the parent's instructions, tools, skills, or subagents. Registered under the framework-reserved name `flue-general`. See [the general-purpose delegate](/docs/guide/subagents/#the-general-purpose-delegate).

## `defineMcpConnection()`

```ts
function defineMcpConnection(definition: McpConnectionDefinition): McpConnectionDefinition;
```

Declare a reusable MCP connection. A typing helper in the [`defineTool()`](#definetool) mold: it validates the definition and returns it frozen, so bad definitions fail at module load instead of first render. The returned object is the exportable unit — define a server once, mount it from any agent with [`useMcpConnection(...)`](/docs/reference/agent-hooks-api/#usemcpconnection), which also accepts the same object inline. Per-mount overrides spread cleanly: `useMcpConnection({ ...linear, tools: ['create_issue'] })`.

## `McpConnectionDefinition`

```ts
type McpTransport = 'streamable-http' | 'sse';
type McpAuth = string | (() => string | Promise<string>);

interface McpConnectionDefinition {
  name: string;
  url: string | URL;
  transport?: McpTransport;
  auth?: McpAuth;
  headers?: HeadersInit;
  requestInit?: RequestInit;
  fetch?: typeof fetch;
  timeoutMs?: number;
  resetTimeoutOnProgress?: boolean;
  tools?: string[];
  optional?: boolean;
}
```

One MCP server, as `defineMcpConnection(...)`, `useMcpConnection(...)`, and [`createMcpConnection(...)`](#createmcpconnection) consume it.

- `name` — the server's `mcp__<server>__` tool namespace. Required, non-empty.
- `url` — the MCP server endpoint. Required; a string must parse as an absolute URL.
- `transport` — defaults to `'streamable-http'` (modern streamable HTTP). Use `'sse'` for legacy MCP servers.
- `auth` — bearer credential, sent as `Authorization: Bearer <token>` on every request. A **function** is resolved fresh per request, for per-user and rotating credentials; on a 401 the transport re-resolves once and retries. See [Authentication](/docs/guide/mcp/#authentication).
- `headers` — **static** extra headers merged into every transport request (set-wins over `requestInit` headers). For credentials, prefer `auth`.
- `requestInit` — additional transport request configuration.
- `fetch` — custom fetch implementation for the transport.
- `timeoutMs` — per-request timeout in milliseconds. Defaults to the MCP SDK default (60 seconds).
- `resetTimeoutOnProgress` — reset the per-request timeout whenever the server sends a progress notification. Default `false`.
- `tools` — allowlist of tools to adapt, by the server's own tool names, in this order. Unknown, repeated, and task-required names reject the connection.
- `optional` — let the agent run without this server when it fails to resolve. Default `false`: a failed connection fails the submission before the model runs. With `optional: true`, any resolve failure mounts zero tools for the submission instead — announced to the model as a [`resources` signal](#dynamic-resources) and to observers as a `log`-level warning event — and the next submission retries.
- Unknown fields throw; so do malformed values, with the offending field named.

## `createMcpConnection()`

```ts
function createMcpConnection(definition: McpConnectionDefinition): Promise<McpConnection>;

interface McpConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

Connects to the remote MCP server described by an [`McpConnectionDefinition`](#mcpconnectiondefinition) — the same object `defineMcpConnection(...)` returns and `useMcpConnection(...)` mounts — and adapts its listed tools into ordinary Flue [`ToolDefinition`](#definetool) values, ready to mount with [`useTool()`](/docs/reference/agent-hooks-api/#usetool). This is the low-level function underneath `useMcpConnection()` — use it when trusted application code should own the connection and work with the tool definitions directly; declare the hook otherwise.

The function is async, so caller-owned connections are typically made at module scope with top-level `await` — **Node target only**: Cloudflare Workers prohibit network I/O in global scope, and a Worker whose module graph connects at top level fails to boot (the violation does not surface under `vite dev`, only at `wrangler dev`/deploy). On Cloudflare, use `useMcpConnection()`.

Definition fields are documented at [`McpConnectionDefinition`](#mcpconnectiondefinition). Connection contract:

- Adapted tool names take the form `mcp__<server>__<tool>`; characters outside `[A-Za-z0-9_-]` are replaced with underscores. Duplicate adapted names reject the connection.
- Adapted descriptions carry the server's own tool description (and `Title:` when the server provides a distinct one). The original tool and server names are spelled out only when sanitization altered a name part — otherwise the adapted name already encodes both.
- Tool discovery follows `tools/list` pagination; a repeated cursor throws. Tools that require task-based execution are skipped with a console warning (allowlisting one is an error).
- `auth` resolves before every request; a 401 re-resolves once and retries, so a credential the application has already refreshed recovers in place.
- A tool result's content is flattened to text for the model; a result with `isError` becomes a tool error. When the server declares an output schema, the MCP client validates structured content against it and a mismatch is an error.
- The adapted definitions are complete — do not wrap them in `defineTool()`.
- `close()` closes the underlying MCP client connection; call it during application shutdown. On any connection or discovery failure, the client is closed before the error propagates. (Hook-declared connections are runtime-owned — the runtime closes them.)

## Dynamic resources

Tools, skills, and subagents may be [declared conditionally](/docs/reference/agent-hooks-api/#rendering-and-the-rules-of-hooks), so the set the model can use changes across renders. The runtime never rewrites the presentation surfaces the model already read — the system prompt's skill catalog and the `task` tool's roster stay frozen on a durable baseline snapshot, so a flip never invalidates the provider's prompt cache. Instead, each render's declared set is diffed against the last-narrated snapshot, and changes are appended to the conversation as signals. Activation and delegation always resolve against the live set: `activate_skill` and the `task` tool's `agent` parameter take plain string names, and an unknown name returns a factual miss listing what is currently available. This section is the contract for those framework-authored signals.

- **`resources` signal** — emitted at a turn boundary when a render's declared tools, skills, or subagents differ from the last-narrated set — or, for a change that happened between responses (a redeploy, a flip in the previous response's final render), before the next response's first turn. One signal per changed kind. The body lists added entries as catalog lines (`- **name** — description`), removals and updates as factual one-liners, and always ends with the full current roster (names only), so a chain of deltas ends in an unambiguous snapshot:

  ```
  <signal type="resources" resource="skill">
  New skill available:
  - **refunds** — Process refund requests against the orders API.
  All available skills: faq, refunds
  </signal>
  ```

  Tool updates are announced name-only — the new description and input schema reach the model natively in the request's tools array. An entry counts as updated when its description changes, or, for tools, when its input-schema digest changes.

- **`resources` signal for MCP availability** (`resource` attribute `mcp`) — emitted before a response's first turn when an [optional MCP connection](#mcpconnectiondefinition) failed to resolve at submission initialization. The body names each unavailable server with the failure reason and states that its tools are not mounted. Emitted once per degraded submission, so a server that stays down is re-announced on each affected response; recovery has no signal of its own — the returning tools narrate through the ordinary tool delta above.
- **`instructions` signal** — emitted when the composed instruction document (the returned prose plus `useInstruction` contributions) changes between renders, detected by digest. The body is the fixed marker `System instructions updated.` — the live system prompt already _is_ the new version, so the signal only pins _when_ the ground shifted. An agent whose instructions churn every render emits this every turn; that visibility is deliberate.
- **`environment` signal** — emitted when a conditional `useSandbox()` presence flip swaps the environment at a turn boundary. Always a full snapshot, never a delta: the new working directory, the complete model-facing tool roster (names only), and the live skill and subagent catalogs, plus a warning that files and results from the previous environment may no longer be accessible. The snapshot supersedes that boundary's delta narration — resources that flipped together with the environment appear in its rosters, not in trailing `resources` signals. The system prompt keeps describing the initialization-time workspace until the next compaction re-discovers the current one. See [Conditional attachment](/docs/guide/sandboxes/#conditional-attachment).
- **Compaction rebaselines.** The post-compaction system prompt snapshots the then-current resource sets, and delta narration starts fresh from that baseline.

These signals appear in the conversation stream like any other record; the vocabulary above is what agent authors can rely on when reading transcripts or writing evals. Narration signals never advance the [`useDelivery()`](/docs/reference/agent-hooks-api/#usedelivery) cursor — they are bookkeeping about the agent's own surface, not input.

**Reserved signal types.** A signal record carrying one of these types is always framework-authored: `dispatch()` admission and the event hooks' `append` reject them. The reserved set is the narration vocabulary above (`resources`, `instructions`, `environment`), the recovery and settlement advisories (`stream_interrupted`, `stream_continued`, `submission_aborted`, `submission_interrupted`), and two names held for future framework use (`compaction`, `memory`). Everything else is application vocabulary.

## See also

- [Agent Hooks API](/docs/reference/agent-hooks-api/) — every hook callable during a render, and the render contract that governs them.
- [Agents guide](/docs/guide/building-agents/) — the walkthrough of agent functions, registration, and the interaction surfaces.
- [Routing](/docs/guide/routing/) — mounting and protecting agent HTTP surfaces.
- [Durability](/docs/guide/durability/) — submissions, recovery, and retry budgets.
- [Agent SDK](/docs/sdk/overview/) — the browser/server client over the conversation URL.
- [`flue run`](/docs/cli/run/) — the CLI surface over the same submission path.
