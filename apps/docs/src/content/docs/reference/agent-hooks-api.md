---
title: Agent Hooks API
description: Every hook callable during an agent render — useModel through the event hooks — and the render contract that governs them.
lastReviewedAt: 2026-07-23
---

This page documents every Flue Hook — the functions an [agent function](/docs/reference/agent-api/#agent-functions) calls while it renders — plus the render contract that governs them. All symbols are exported from `@flue/runtime` unless noted. Each hook's section covers the hook's own contract — arguments, render rules, when it runs — and defers to the [Agent API](/docs/reference/agent-api/) for the resource shapes hooks consume ([`defineTool`](/docs/reference/agent-api/#definetool), [`defineSkill`](/docs/reference/agent-api/#defineskill), [`defineSubagent`](/docs/reference/agent-api/#definesubagent), [`defineMcpConnection`](/docs/reference/agent-api/#definemcpconnection)) and for the programmatic surface _around_ agents (`dispatch()`, `init()`, `start()`, routing, the harness).

The hooks:

- [`useModel()`](#usemodel) — declare the agent's LLM and its tuning. Required.
- [`useSandbox()`](#usesandbox) — attach the agent's execution environment.
- [`useTool()`](#usetool) — mount a model-callable tool.
- [`useMcpConnection()`](#usemcpconnection) — declare a remote MCP server whose tools the agent uses.
- [`useSkill()`](#useskill) — mount a skill in the agent's catalog.
- [`useSubagent()`](#usesubagent) — declare a delegate for the `task` tool.
- [`useInstruction()`](#useinstruction) — append raw instruction text.
- [`usePersistentState()`](#usepersistentstate) — durable per-instance state.
- [`useInitialData()`](#useinitialdata) — read instance-creation data.
- [`useDelivery()`](#usedelivery) — read the message in front of the model.
- [`useDispatchMessage()`](#usedispatchmessage) — a dispatcher bound to this instance.
- [`useDataWriter()`](#usedatawriter) — stream named data parts to clients.
- [`useAgentStart()`](#useagentstart) — run a callback when work starts on a delivered message.
- [`useAgentFinish()`](#useagentfinish) — run a callback at every would-stop point of a response.
- [`useResponseStart()`](#useresponsestart) — observe a response's true start.
- [`useResponseFinish()`](#useresponsefinish) — observe a response's true end.

## Rendering and the rules of hooks

The runtime runs the agent function — a **render** — before every model call: at each turn, and the moment a delivery joins a live response. Every render starts from a fresh frame; hooks record onto it in call order.

Call-site rules:

- Hooks may only be called while the agent function renders: synchronously in its body, or in a [custom hook](#custom-hooks) it calls. Called anywhere else — tool `run` functions, event-hook callbacks, module scope — every hook throws `[flue] <hook>() was called outside an agent function.`
- A custom hook is a plain function; hooks it calls record exactly as if the agent body had called them directly.
- Renders are pure reads. The write functions hooks return (`usePersistentState` setters, `useDataWriter` writers, the `useDispatchMessage` dispatcher) throw when called during a render; call them from tool `run` functions and other callbacks that run while the agent is responding.

What may vary between renders, and what may not:

- **Conditional and reorderable** — `useTool`, `useSkill`, `useSubagent` (the runtime narrates set changes to the model as `resources` signals; see [Dynamic resources](/docs/reference/agent-api/#dynamic-resources)); `useMcpConnection` (conditional too, with submission granularity — a declaration added or dropped takes effect at the next submission, narrated the same way); `usePersistentState` (storage is keyed by name, not by declaration order or presence); the four event hooks (no durable identity — each seam runs whatever the current render declares); `useSandbox` **presence** (a flip swaps the environment at the next turn boundary, narrated as an `environment` signal).
- **Identity-invariant** — `useDataWriter` names must be declared identically on every render; they are the response's client-facing identity. A delta between consecutive renders throws with the exact added/removed names.
- **Required, exactly once** — `useModel`. The argument may vary render to render; the call may not disappear, and a render that never calls it cannot start (`[flue] ... requires a model. Call useModel('provider-id/model-id') in the agent function.`).
- Within one render, duplicate names throw everywhere they identify something: tool names, MCP server names, skill names, subagent names, state names, data-part names. `useModel` and `useSandbox` throw when called twice.

Value scoping:

- `useModel` values (model, `thinkingLevel`, `compaction`), the `useSandbox` factory and `cwd`, and `useMcpConnection` definitions are **submission-scoped**: read once when a submission starts. A different value computed by a later render takes effect on the next submission, not mid-run. The one exception is `useSandbox` _presence_, which is re-read at every turn boundary.
- Resource sets (tools, skills, subagents) and instruction text are **per-render**: each model call uses what the current render declared.

Root and subagent renders:

- A delegate's agent function renders in its own **subagent frame** at delegation time, fresh per task. `useTool`, `useSkill`, `useInstruction`, nested `useSubagent`, and custom hooks compose as usual there.
- Instance-scoped and client-facing hooks throw in a subagent render: `useModel` (a delegate's model comes from its [definition](/docs/reference/agent-api/#subagentdefinition)), `useSandbox` (delegates share the parent environment), `useMcpConnection`, `usePersistentState`, `useDataWriter`, `useDispatchMessage`, and all four event hooks. `useInitialData()` returns `undefined` instead of throwing; `useDelivery()` returns the parent's task prompt.

The four **event hooks** — `useAgentStart`, `useAgentFinish`, `useResponseStart`, `useResponseFinish` — run callbacks at fixed seams of a response's lifecycle, under a shared contract:

- One **response** may absorb several delivered messages (deliveries that join at turn boundaries). `useAgentStart` runs once per delivered message; `useAgentFinish` runs at every would-stop point; `useResponseStart` and `useResponseFinish` run once per response, at its true start and true end.
- Declarations have no durable identity: declare them conditionally, reorder them, add or remove them across deploys — each seam runs whatever the current render declares. Identity within a render is declaration order.
- `useAgentStart`/`useAgentFinish` are awaited, may be async, and receive a [harness](/docs/reference/agent-api/#harness); `useResponseStart`/`useResponseFinish` are synchronous observers — a returned promise fails the submission.
- A callback throw fails the submission.
- Callbacks run at-least-once: their durable outcomes (signal appends, state writes) commit atomically per seam, so a crash mid-seam leaves nothing durable and re-runs the callbacks on the next attempt. Durable effects never duplicate; external side effects (network calls, files) may rarely happen twice — make them idempotent or guard them with persistent state.

## `useModel()`

```ts
function useModel(model: string, options?: UseModelOptions): void;

interface UseModelOptions {
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
```

Declare the agent's model. Required: an agent render without a `useModel` call cannot start. Call it exactly once per render, in the agent body or a custom hook — a second call in one render throws, and a subagent render throws (delegates declare their model on the `useSubagent` definition).

- `model` — a model specifier string, `'provider-id/model-id'` (e.g. `'anthropic/claude-sonnet-4-6'`). An unresolvable specifier fails the submission at initialization. See [Models](/docs/guide/models/#model-specifier) for the catalog and [Provider API](/docs/reference/provider-api/) for registering providers.
- `options.thinkingLevel` — the agent-wide default reasoning effort. Individual `harness.prompt()` calls may override it. When unset, the harness substitutes `'medium'`. An unknown value throws.
- `options.compaction` — threshold-compaction configuration ([`CompactionConfig`](#compactionconfig), below), or `false` to disable threshold compaction. Overflow recovery and explicit [`harness.compact()`](/docs/reference/agent-api/#harnesscompact) still compact when needed.
- Unknown option fields throw.
- Values are submission-scoped: the runtime reads them when a submission starts, so a value computed from state takes effect on the next submission, not mid-run. See [Changing models mid-conversation](/docs/guide/models/#changing-models-mid-conversation).

## `CompactionConfig`

```ts
interface CompactionConfig {
  reserveTokens?: number;
  keepRecentTokens?: number;
  model?: string;
}
```

The threshold-compaction options accepted by [`useModel()`](#usemodel)'s `compaction` option.

- `reserveTokens` — token headroom reserved in the context window; compaction triggers when used tokens exceed `contextWindow - reserveTokens`. Defaults to a model-aware value capped at 20,000 tokens, shrunk for models with smaller output limits and adjusted when the reserve would consume half or more of a small context window. Positive integer.
- `keepRecentTokens` — recent tokens preserved verbatim after compaction; older messages fold into the summary. Default `8000`. Lower values compact more aggressively at the cost of recent-context fidelity. Positive integer.
- `model` — model specifier override for the summarization calls, `'provider-id/model-id'`. Defaults to the session's model.
- Unknown fields throw.

## `useSandbox()`

```ts
function useSandbox(sandbox: SandboxFactory, options?: UseSandboxOptions): void;

interface UseSandboxOptions {
  cwd?: string;
}
```

Attach the environment this agent instance runs in. The factory's `createSessionEnv()` builds the filesystem/exec surface once per initialized harness (adapters key durable resources on the instance id), and its `tools()` — when present — **replaces** the sandbox-backed model-facing tool set. Without the hook, the agent has no environment: the built-in file and shell tools aren't added, and sandbox-backed operations (`harness.sandbox`, workspace discovery) don't happen. The [`SandboxFactory` contract](/docs/reference/sandbox-api/#sandboxfactory) is documented in the Sandbox Adapter API; first-party factories include [`bash()`](/docs/reference/sandbox-api/#bashfactory) over a [just-bash](https://github.com/vercel-labs/just-bash) instance and [`local()`](/docs/guide/node-target/#local) from `@flue/runtime/node`.

- `sandbox` — a `SandboxFactory` value, passed directly (the factory is already lazy; the expensive `createSessionEnv()` call happens once, at initialization). A value without a `createSessionEnv` function throws; a non-function `tools` property throws.
- `options.cwd` — the agent's working directory inside the initialized environment. Non-empty string. Read once when a submission starts. Unknown option fields throw.
- At most once per render; a second call throws. Subagent renders throw — delegates share the parent's environment (scope work with the task call's `cwd` instead).
- Re-renders never rebuild the environment.
- The call may be conditional. Presence is read at initialization and at every turn boundary: when it flips, the runtime swaps the environment before the next model call — attach resolves the declared factory, detach removes the environment and its tools (nothing carries over) — and announces the change as one [`environment` signal](/docs/reference/agent-api/#dynamic-resources) restating the full current state.
- Only **presence** is observable across renders (factories are fresh objects every render). Replacing one factory with another while staying attached takes effect at the next submission's initialization, not mid-run.
- A condition derived from persistent state replays durably: every later submission re-attaches the same declaration, and adapters keyed on the instance id resolve back to the same durable workspace. See [Conditional attachment](/docs/guide/sandboxes/#conditional-attachment).

## `useTool()`

```ts
function useTool(tool: ToolDefinition): void;
```

Mount a model-callable tool for the current render. Accepts a [`defineTool(...)`](/docs/reference/agent-api/#definetool) value or an inline definition object — the same validation applies at the mount site. Whether called in the agent body or a custom hook, the tool joins the render's single flat tool set. What a tool _is_ — the full definition contract, `ToolContext`, and the `harness`/`durable` flags — is documented at [`defineTool()`](/docs/reference/agent-api/#definetool) in the Agent API.

- Mounts may be conditional; set changes are narrated to the model (see [Dynamic resources](/docs/reference/agent-api/#dynamic-resources)). An unmounted tool cannot be called at all.
- Duplicate tool names across the whole render throw `ToolNameConflictError`.
- Invalid definitions throw at mount with the same messages as `defineTool()`.

## `useMcpConnection()`

```ts
function useMcpConnection(definition: McpConnectionDefinition): void;
```

Declare a remote MCP server whose tools this agent uses. Accepts an [`McpConnectionDefinition`](/docs/reference/agent-api/#mcpconnectiondefinition) — typically the frozen object [`defineMcpConnection(...)`](/docs/reference/agent-api/#definemcpconnection) exports, or the same shape written inline (same validation, applied at the mount site). The runtime connects when a submission initializes — inside request context, on every target, all declared servers in parallel — and mounts the server's tools into the render's flat tool set as `mcp__<server>__<tool>`. Usage patterns live in the [MCP guide](/docs/guide/mcp/); the definition shape and adaptation contract live in the Agent API.

- Definitions are read once per submission at initialization. A conditional declaration takes effect on the next submission, narrated as a [`resources` signal](/docs/reference/agent-api/#dynamic-resources).
- Connections are reused for the instance's in-memory lifetime; definitions are read at first connect (`auth` excepted — resolved per request). A failed connect fails the submission before the model runs and is never cached — unless the definition sets `optional: true`, which mounts zero tools for the submission and announces the gap to the model instead (see [`McpConnectionDefinition`](/docs/reference/agent-api/#mcpconnectiondefinition)).
- Duplicate server names in one render throw. Subagent renders throw — declare the connection on the root agent.

## `useSkill()`

```ts
function useSkill(skill: Skill): void;

type Skill = SkillReference | SkillDefinition;

interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

Mount a skill in the agent's catalog. Skills are progressive disclosure: every mounted skill costs one always-present catalog line (name + description) in the system prompt, and the model pulls the full instructions on demand with the framework's `activate_skill` tool — the briefing arrives as a tool result, so the prompt prefix never changes. Supporting files stay lazy until explicitly read.

- Accepts a `SkillReference` — the value of a `SKILL.md` import (packaged automatically by the build; see [Skills](/docs/guide/skills/#import-and-mount-a-skill)) or a [`defineSkill(...)`](/docs/reference/agent-api/#defineskill) result — or an inline [`SkillDefinition`](/docs/reference/agent-api/#skilldefinition) object, validated at the mount site. The definition contract — every field and constraint — is documented in the Agent API.
- Mounting the same skill name twice in one render throws.
- Mounts may be conditional; catalog changes are narrated (see [Dynamic resources](/docs/reference/agent-api/#dynamic-resources)).
- Always-on content needs no skill: import the markdown as a string (any `.md` import loads as text) and pass it to [`useInstruction()`](#useinstruction).

## `useSubagent()`

```ts
function useSubagent(subagent: SubagentDefinition): void;
```

Declare a delegate the model can hand focused work to via the framework's `task` tool. Delegation is a declared capability: the `task` tool is always in the tool set with a fully static spec (either changing would rewrite the serialized tools block and invalidate the provider's prompt cache), the roster lives in the system prompt's "Available Agents" section, and the tool's required `agent` parameter only resolves against declared subagents — with an empty roster the tool is inert. The definition shape — [`SubagentDefinition`](/docs/reference/agent-api/#subagentdefinition), the [`defineSubagent()`](/docs/reference/agent-api/#definesubagent) helper, and the blank general-purpose [`GeneralSubagent`](/docs/reference/agent-api/#generalsubagent) — is documented in the Agent API.

- Duplicate delegate names in one render throw. Declarations may be conditional; roster changes are narrated ([Dynamic resources](/docs/reference/agent-api/#dynamic-resources)).
- The delegate's `agent` function is rendered at delegation time, in its own frame, fresh per task — closures read current values, and two delegations to the same subagent render independently.
- The delegate is isolated from the parent: nothing flows in except the shared environment and, unless overridden on the definition, the parent's model and reasoning effort. It runs a detached session, and only its final text returns to the parent. See [Subagents](/docs/guide/subagents/) and the [subagent-render hook rules](#rendering-and-the-rules-of-hooks).

## `useInstruction()`

```ts
function useInstruction(text: string): void;
```

Append raw instruction text for the current render — the deliberately low-level escape hatch. Text lands after the agent's returned instruction, in call order, joined with blank lines; the author owns all formatting. No structure, no identity, no per-fragment change tracking (the composed document is digest-tracked as a whole; see the [`instructions` signal](/docs/reference/agent-api/#dynamic-resources)).

- `text` — required, non-empty after trimming; anything else throws.
- Callable in root and subagent renders, any number of times.

## `usePersistentState()`

```ts
function usePersistentState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
function usePersistentState<T = unknown>(name: string): [T | undefined, StateSetter<T | undefined>];

type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
```

Durable agent state: an API over the instance's record log. The hook reads the value as of this render and returns a setter that persists a new value — directly, or through an updater resolved at call time. Reads are render-time snapshots; writes are silent — they never post a message, never wake the agent, and never re-render mid-run. The next render reads the latest persisted values.

- Values are JSON: writes are normalized through a JSON round-trip and throw on non-serializable input. Setting `undefined` throws — there is no unset; a name, once written, always has a value. `defaultValue` fills in before the first write and is never persisted itself.
- The updater form (`set((previous) => next)`) is the read-modify-write path: `previous` resolves at **call** time through the attempt's write buffer, not the render snapshot the closure was born with — two callbacks in one turn composing with updaters cannot drop each other's writes. Any function argument is treated as an updater (a function was never a legal value).
- Writing a value deep-equal to the current one is a no-op; no record is appended.
- Writes made by tools become durable atomically with the tool batch that made them: if the batch settles, the write is durable; if recovery settles the batch as interrupted, the write never happened. See [Durability](/docs/guide/durability/#persisted-state).
- The setter throws during render (renders are pure reads) and on bare tooling/test renders with no durable runtime behind them.
- State is scoped to the agent instance, keyed by `name`. Declaring the same name twice in one render throws; declaring a name conditionally across renders is legal — a render that skips the declaration is a render that didn't touch it, and the recorded value is read again when the declaration returns.
- Subagent renders throw — durable state is instance-scoped, and delegates run detached tasks. Pass what a delegate needs through the task prompt.
- The type parameter is compile-time only; nothing parses persisted values at runtime. For enforcement, assert at the call site or compose a schema-checking custom hook over this one.

## `useInitialData()`

```ts
function useInitialData<T = unknown>(): T;
```

Read the instance's creation data — the `initialData` a caller sent with this instance's first contact, recorded exactly once at creation and constant for the instance's whole life. Evolving facts belong in `usePersistentState`; per-message facts in `useDelivery`.

- With an [`initialData` schema static](/docs/reference/agent-api/#agent-statics) on the agent, the value is validated at creation (a mismatch fails the creating send, so the value is always present here) and the hook returns the schema-parsed output. Without a schema, whatever the creator sent is returned untyped.
- `initialData` sent to an existing instance is ignored; nothing can change the recorded value.
- The return type is exactly the type parameter asserted. At runtime the value **is** `undefined` when creation carried no data, on bare tooling/test renders, and in subagent renders (a delegate has no creation data of its own). When those cases apply, say so in the type: `useInitialData<Config | undefined>()`.
- The recorded value is part of the instance's durable record stream but is never served to clients. It is still not a secrets channel — keys and tokens stay in the environment.

## `useDelivery()`

```ts
function useDelivery(): DeliveredMessage;
```

Read the message currently in front of the model, as the same validated [`DeliveredMessage`](/docs/reference/agent-api/#deliveredmessage) shape every transport admits. The value is a cursor: it starts as the delivery that woke the response and advances whenever a new message reaches the model — a delivery joining the live response at a turn boundary, or a signal appended by an event-hook callback. It gives code the same access the model has, so tools need not depend on the model echoing values back into their input.

- Transport- and origin-agnostic: a direct HTTP prompt, a `dispatch()` call, and an event hook's `append` produce the same shapes here.
- [Framework narration signals](/docs/reference/agent-api/#dynamic-resources) (`resources`/`instructions`/`environment`) do not advance the cursor — bookkeeping about the agent's own declared surface never displaces the input the response is answering.
- Constant within one render; fresh at the next. Renders happen before every model call, and when several messages collect into one response the cursor walks them in the order the model read them. A `useAgentStart` callback firing for a joined message reads that message.
- Crash-safe: a resumed attempt derives the same cursor from the durable record stream the live attempt saw.
- In a subagent render, the delivery is the parent's task prompt as a `kind: 'user'` message (task images ride as `attachments`).
- Always present in the runtime: every response starts from a delivered message. A bare tooling/test render with no delivery behind it throws.

## `useDispatchMessage()`

```ts
function useDispatchMessage(): (message: DeliveredMessageInput) => Promise<DispatchReceipt>;
```

Get a dispatcher bound to this agent instance — the agent-scoped form of the top-level [`dispatch()`](/docs/reference/agent-api/#dispatch). The returned function takes just the message: the instance already exists, so there is no `initialData` and no `uid` condition. Semantics are identical to the global verb by construction — same queue, same admission, same delivery, one accepted order shared with direct HTTP prompts.

- Both message kinds work; a bare string is shorthand for `{ kind: 'user', body }`.
- A dispatch to the busy own instance joins the live response at the next turn boundary — durably admitted, its own `useAgentStart` run, read by the model on its next turn — without interrupting the turn in flight. A dispatch to an idle instance wakes a new response. A delivery that misses the live response runs as its own submission from the durable queue; it is never lost.
- A joined delivery settles when the response that carried it settles, with the same outcome, under the host response's durability budget. A joined HTTP prompt still writes its own `submission_settled` record, so an SDK `wait()` resolves exactly as if it had run alone.
- Each call is a durable delivery with its own receipt. Like any external side effect in a re-attempted tool, a re-run dispatches again — design for at-least-once.
- The dispatcher throws when called during render, on bare tooling/test renders, and before a runtime is configured. The hook itself throws in subagent renders — a delegate has no instance of its own; it returns what it produced as its task result instead.

## `useDataWriter()`

```ts
function useDataWriter<TSchema extends v.GenericSchema>(
  name: string,
  options: { schema: TSchema },
): (data: v.InferOutput<TSchema>) => void;
function useDataWriter(name: string): (data: unknown) => void;
```

Declare a named, client-facing data part and get back a write-only function that streams it. Output is one-way and non-reactive: the model never sees data parts, writes never re-run the agent, and nothing is read back. Each write is appended durably and streamed to clients immediately, so a part can show live progress mid-tool-run.

- `name` — the part's identity within the response (AI SDK convention: `data-<name>` in the response message's parts). The first write places the part; later writes update it in place. Mounting emits nothing; the part exists only once first written.
- `options.schema` — a Valibot schema validating every write; the writer throws on mismatch. Unknown option fields throw.
- Values are JSON: writes are normalized through a JSON round-trip; `undefined` and non-serializable values throw.
- The writer throws during render and on bare tooling/test renders with no durable runtime behind it.
- Names are unique per render **and part of the render's structural identity** — declare `useDataWriter` calls unconditionally, identical on every render; a delta between renders throws. A custom hook that declares one inherits that rule. The hook throws in subagent renders.
- Parts land on the wire as data parts of the conversation message and on [`AgentReply.data`](/docs/reference/agent-api/#agentreply); see [Streaming data to the client](/docs/guide/agent-hooks/#streaming-data-to-the-client).

## `useAgentStart()`

```ts
function useAgentStart(run: (ctx: AgentStartContext) => void | Promise<void>): void;

interface AgentStartContext {
  readonly append: (message: AgentAppendMessage) => void;
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
  readonly signal: AbortSignal;
}
```

Run a callback when the agent starts work on a delivered message — after the input is durable, before the model's first turn. The intake seam: load what the model should wake up knowing, seed files, write durable state, and announce it by dispatching a signal. Callbacks are awaited and may be async; a throw fails the submission, and execution is at-least-once with durable outcomes committed atomically per seam — the [shared event-hook contract](#rendering-and-the-rules-of-hooks).

- Runs once per delivered message, before the model reads it — including deliveries that join a live response mid-run. Not reactive: callbacks never re-run for a message already dealt with. For once-per-instance work, guard with durable state.
- A delivery's callbacks run **concurrently, in no guaranteed order**; the model waits for the slowest. Never rely on a sibling callback's writes — work that needs ordering composes into one callback. Appended signals reach the conversation grouped in declaration order regardless of completion order.
- All output is explicit: model-facing signals via the [`useDispatchMessage()`](#usedispatchmessage) dispatcher (each is a real delivery that fires these hooks itself — guard with durable state), durable values via state setters, files via the harness.
- `ctx.append` writes a signal into this response **without** registering a delivery — no `useAgentStart` run of its own, no submission. It accepts the same [`AgentAppendMessage`](#useagentfinish) shape and validation as `useAgentFinish`'s `append`, and it is legal only during the callback's execution window; a captured reference throws afterwards. Prefer dispatching; reach for `append` only when a delivery is wrong.
- `ctx.harness` is the [harness](/docs/reference/agent-api/#harness), materialized lazily on first access. `ctx.signal` is the submission's abort signal. `ctx.log` emits progress lines into the conversation stream; the model never sees them.
- Compaction can eventually fold signals away — keep a callback's substance in durable state and files; a signal is the announcement, not the storage.

## `useAgentFinish()`

```ts
function useAgentFinish(run: (ctx: AgentFinishContext) => void | Promise<void>): void;

interface AgentFinishContext {
  readonly response: {
    readonly toolCalls: readonly AgentResponseToolCall[];
    readonly usage: PromptUsage;
  };
  readonly append: (message: AgentAppendMessage) => void;
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
  readonly signal: AbortSignal;
}

interface AgentResponseToolCall {
  tool: string;
  isError: boolean;
}

interface AgentAppendMessage {
  kind: 'signal';
  type: string;
  body: string;
  attributes?: Record<string, string>;
  tagName?: string;
}
```

Run a callback when the agent would otherwise finish responding — the model has no more tool calls and the response is about to settle. The enforcement seam: inspect what the response actually did and, if the work is not done, `append` a signal to send the model back to work within the same response. Callbacks are awaited and may be async, receive a [harness](/docs/reference/agent-api/#harness), and a throw fails the submission — the [shared event-hook contract](#rendering-and-the-rules-of-hooks).

- A control seam, not a passive tap: callbacks are awaited before the response settles. `ctx.append` steers a signal into the same response — another turn runs, and once that continuation is dealt with the hook runs again at the next would-stop point. The response settles only when a cycle completes with no appends **and** no delivered input is waiting; queued deliveries join before any finish evaluation, so several messages collect into several `useAgentStart` runs and one final `useAgentFinish`.
- `append` accepts only `kind: 'signal'` messages, with the same validation as delivered signals (non-empty `type`, string `body`, string-to-string `attributes`, XML-name `tagName`); a `kind: 'user'` message throws — real new input belongs on `useDispatchMessage()`. [Framework-reserved signal types](/docs/reference/agent-api/#dynamic-resources) throw too. It is legal only during the callback's execution window.
- Append vs. dispatch: an append is the response steering itself — no `useAgentStart` run, no submission of its own, counted against the continuation ceiling. A dispatch from this callback is a real delivery — it joins the same response and the hook fires again at the new true end, with its own `useAgentStart` run, never counted against the ceiling.
- Runs on delivered submissions only, in declaration order, sequentially; multiple hooks share each cycle, and the response continues if any of them appended.
- `response.toolCalls` aggregates every tool call the response has made — across all turns and re-attempts, derived from durable records. `response.usage` is the aggregate usage so far (the settled total belongs to `useResponseFinish`).
- Durable: a continued cycle is a response-control checkpoint, recorded atomically with its signals — a resumed response drives a checkpoint's pending continuation instead of re-evaluating, so it never re-runs a completed cycle or appends twice. An evaluation interrupted before its checkpoint re-runs wholesale on the re-attempt (at-least-once).
- Runaway protection is a fixed framework ceiling of 32 continuation cycles per response, not configurable: a hook that appends unconditionally fails the submission loudly instead of settling as a success. The submission's [durability timeout](/docs/reference/agent-api/#durabilityconfig) remains the total wall-clock backstop — neither continuations nor joins extend it.

## `useResponseStart()`

```ts
function useResponseStart(run: ResponseMetadataCallback<ResponseStartContext>): void;

type ResponseMetadataCallback<TCtx> = (ctx: TCtx) => Record<string, unknown> | void;

interface ResponseStartContext {
  readonly metadata: Record<string, unknown>;
  readonly log: FlueLogger;
}
```

Observe the response's true start — once per response, synchronously, before the first model call and before any `useAgentStart` callback. Return a plain object to deep-merge onto the response message's metadata (AI SDK convention: the message's `metadata` field — envelope facts clients read outside the content flow). Return nothing to observe without attaching.

- Once per response: deliveries that join a live response re-fire `useAgentStart`, but the response only wakes once — this hook does not re-fire. A resume whose response already has durable assistant steps skips it; a re-attempt from before the first durable step re-runs it (at-least-once).
- Synchronous observer: no append, no dispatch, no harness. A returned promise fails the submission; async start-seam work belongs in `useAgentStart`.
- `ctx.metadata` is the metadata accumulated so far this response (earlier hooks' contributions, in declaration order), handed in at call time — never a stale render capture. Returns compose by deep-merge; later keys win, `undefined` values are skipped, prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are dropped. A non-object, array, or promise return fails the submission.
- Fail-fast: a throw fails the submission — no retry, no recovery.
- Metadata is model-invisible and non-reactive; the runtime stamps no keys of its own. It reaches clients on the conversation stream and on [`AgentReply.metadata`](/docs/reference/agent-api/#agentreply).

## `useResponseFinish()`

```ts
function useResponseFinish(run: ResponseMetadataCallback<ResponseFinishContext>): void;

interface ResponseFinishContext {
  readonly metadata: Record<string, unknown>;
  readonly response: {
    readonly usage: PromptUsage;
    readonly toolCalls: readonly AgentResponseToolCall[];
  };
  readonly log: FlueLogger;
}
```

Observe the response's true end — once per response, synchronously, after the last `useAgentFinish` cycle settles and every queued output write has flushed. Same return contract, merge rules, and failure semantics as [`useResponseStart()`](#useresponsestart).

- Runs after the final finish cycle, when the response is actually settling; its `response.usage` and `response.toolCalls` aggregates are final.
- `ctx.metadata` includes what `useResponseStart` hooks attached — read from the durable record log, so it survives re-attempts — plus earlier finish hooks' contributions.
- Async finish-seam work belongs in `useAgentFinish`.

## Custom hooks

A custom hook is a plain function, named with a `use` prefix by convention, that calls other hooks. There is no registration and no wrapper: because the render frame is ambient, hooks called inside it record exactly as if the agent body had called them directly, in the same call order. Custom hooks may take arguments and return values to the agent body, and they compose — a custom hook may call other custom hooks.

```ts
function useRetention(active: () => boolean) {
  useTool({
    ...offerCredit,
    run: (ctx) => (active() ? offerCredit.run(ctx) : 'Refused: no churn risk on record.'),
  });
  useInstruction(
    'Only while the customer is weighing cancellation: you may offer retention incentives.',
  );
}
```

All [rules of hooks](#rendering-and-the-rules-of-hooks) apply through custom hooks unchanged — a custom hook called outside a render throws at its first inner hook call, and per-render uniqueness (one `useModel`, one `useSandbox`, unique names) counts hooks called through any depth of custom hooks.

## See also

- [Agent API](/docs/reference/agent-api/) — the agent module contract, `dispatch()`, `init()`, `start()`, routing, the harness surface, and the `defineTool`/`defineSkill`/`defineSubagent` resource helpers.
- [Agent Hooks guide](/docs/guide/agent-hooks/) — the walkthrough of hooks, state, event hooks, and data writers.
- [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), [Subagents](/docs/guide/subagents/), [Models](/docs/guide/models/), [Sandboxes](/docs/guide/sandboxes/) — per-capability guides.
- [Errors](/docs/reference/errors/) — the error classes hooks and tools throw.
