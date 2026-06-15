---
title: Agent API
description: Reference for defining agents and running agent operations with @flue/runtime.
lastReviewedAt: 2026-06-15
---

The agent API is exported from `@flue/runtime`.

```ts
import {
  FlueError,
  ResultUnavailableError,
  ToolInputValidationError,
  bash,
  connectMcpServer,
  createAgent,
  defineAgentProfile,
  defineTool,
  dispatch,
  type AgentCreateContext,
  type AgentDispatchRequest,
  type AgentHarnessOptions,
  type AgentProfile,
  type AgentRouteHandler,
  type AgentRuntimeConfig,
  type AgentWebSocketHandler,
  type BashFactory,
  type BuiltInToolName,
  type BuiltInToolsConfig,
  type CallHandle,
  type CompactionConfig,
  type CreatedAgent,
  type DispatchReceipt,
  type FileStat,
  type FlueContext,
  type FlueFs,
  type FlueHarness,
  type FlueLogger,
  type FlueSession,
  type FlueSessions,
  type McpServerConnection,
  type McpServerOptions,
  type NamedAgentDispatchRequest,
  type PromptImage,
  type PromptModel,
  type PromptOptions,
  type PromptResponse,
  type PromptResultResponse,
  type PromptUsage,
  type SandboxFactory,
  type ShellOptions,
  type ShellResult,
  type Skill,
  type SkillOptions,
  type SkillReference,
  type TaskOptions,
  type ThinkingLevel,
  type ToolArgs,
  type ToolDefinition,
  type ToolParameters,
  type ToolValidationIssue,
} from '@flue/runtime';
```

## `defineAgentProfile(...)`

```ts
function defineAgentProfile(profile: AgentProfile): AgentProfile;
```

Validates and returns a reusable agent profile. Use profiles as the baseline for a created agent or as named subagents available to `session.task()`.

Throws when the profile contains unknown fields, invalid capabilities, duplicate capability names, or circular subagents.

#### `AgentProfile`

| Field           | Type                        | Description                                                                                                                                                                             |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | `string`                    | Profile name. Required when selecting this profile with `session.task()`.                                                                                                               |
| `description`   | `string`                    | Human-readable profile description.                                                                                                                                                     |
| `model`         | `string \| false`           | Default model specifier. Set to `false` to require call-level model selection.                                                                                                          |
| `instructions`  | `string`                    | Instructions prepended to discovered workspace context.                                                                                                                                 |
| `skills`        | `Skill[]`                   | Registered skills available to initialized sessions.                                                                                                                                    |
| `tools`         | `ToolDefinition[]`          | Custom model-callable tools available to initialized sessions.                                                                                                                          |
| `builtInTools`  | `BuiltInToolsConfig`        | Built-in model-callable tools available to initialized sessions. Omit for the full default set, set to `false` to disable all built-ins, or provide names to keep only those built-ins. |
| `subagents`     | `AgentProfile[]`            | Named profiles available for delegated `session.task()` operations.                                                                                                                     |
| `thinkingLevel` | `ThinkingLevel`             | Default reasoning effort. Individual operations may override this value.                                                                                                                |
| `compaction`    | `false \| CompactionConfig` | Automatic conversation-compaction configuration. `false` disables threshold compaction; overflow recovery and explicit `session.compact()` calls still compact when needed.             |
| `durability`    | `DurabilityConfig`          | Durability configuration for durable agent submissions. Controls recovery attempt limits and submission timeouts. Rejected on subagent profiles.                                        |

When a profile is selected as a subagent with `session.task()`, it is self-contained: `instructions`, `tools`, `skills`, and `subagents` apply only as declared on the profile (omitted means none), while `builtInTools` uses the profile's own selection and preserves the default built-in set when omitted. `model`, `thinkingLevel`, and `compaction` inherit from the parent as defaults. See [Subagents](/docs/guide/subagents/#configuration-inheritance).

#### `DurabilityConfig`

| Field         | Type     | Default   | Description                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts` | `number` | `10`      | Maximum total attempts before the submission is terminalized as failed. The initial run counts as the first attempt; each interruption that requires a new attempt consumes another.                                                                                                                     |
| `timeoutMs`   | `number` | `3600000` | Maximum wall-clock milliseconds for a single submission. Submissions exceeding this limit are aborted and settled as failed. Set higher for long-running agents (e.g. `21_600_000` for a 6-hour agent). The timeout is checked cooperatively at turn boundaries, not preemptively during provider calls. |

#### `CompactionConfig`

| Field              | Type     | Default                        | Description                                                                                                                     |
| ------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `reserveTokens`    | `number` | model-aware; capped at `20000` | Token headroom reserved before automatic compaction. Smaller model output limits and small context windows reduce this default. |
| `keepRecentTokens` | `number` | `8000`                         | Recent tokens preserved unsummarized after compaction.                                                                          |
| `model`            | `string` | session model                  | Model specifier override used for compaction summaries.                                                                         |

#### `Skill`

```ts
type Skill =
  | SkillReference
  | {
      name: string;
      description: string;
    };
```

Skill metadata registered with an agent, harness, or profile. Imported `SkillReference` values bundle application-owned skill content. Inline metadata adds only a named catalog entry; it does not package or inject an instruction body. Initialization rejects a registered skill whose name collides with a workspace-discovered skill. See [Skills](/docs/guide/skills/).

#### `BuiltInToolsConfig`

```ts
type BuiltInToolsConfig = false | readonly BuiltInToolName[];

type BuiltInToolName =
  | 'read'
  | 'write'
  | 'edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'task'
  | 'activate_skill'
  | (string & {});
```

Controls Flue and sandbox adapter built-in tools by model-facing name. Omit `builtInTools` for the full default set. Use `false` for custom tools only. Use an array such as `['read', 'grep']` to keep only selected built-ins. Sandbox adapters may expose additional names, such as `code`; include those names in the array when selecting a subset.

## `defineTool(...)`

```ts
function defineTool<TParams extends ToolParameters>(tool: ToolDefinition<TParams>): ToolDefinition;
```

Validates a custom model-callable tool and returns a shallow-frozen, normalized copy.

Valibot `parameters` are converted to plain JSON Schema once at definition time, and `execute` is wrapped so model-supplied arguments are parsed against the schema before the callback runs. A validation failure throws `ToolInputValidationError`, which the agent loop returns to the model as an error tool result so it can retry with corrected arguments; `meta.issues` carries the failures as `ToolValidationIssue` values in [Standard Schema](https://standardschema.dev)'s issues shape. Tool names are checked for collisions with other active tools when a session assembles its tool list.

#### `ToolDefinition`

| Field         | Type                                                                 | Description                                                                                                                                 |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`                                                             | Tool name. Must be unique across active built-in and custom tools.                                                                          |
| `description` | `string`                                                             | Tells the model when and how to use this tool.                                                                                              |
| `parameters`  | `ToolParameters`                                                     | Valibot object schema (`v.object({ ... })`), or a raw JSON Schema object for schemas produced elsewhere (e.g. MCP).                         |
| `execute`     | `(args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string>` | Receives the parsed, typed arguments (the schema's `v.InferOutput`). Returns text sent back to the model. Thrown errors become tool errors. |

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const lookupPolicy = defineTool({
  name: 'lookup_policy',
  description: 'Read one approved policy by topic.',
  parameters: v.object({ topic: v.string() }),
  execute: async ({ topic }) => readPolicy(topic),
});
```

## `connectMcpServer(...)`

```ts
function connectMcpServer(name: string, options: McpServerOptions): Promise<McpServerConnection>;
```

Connects to a remote MCP server and adapts its listed tools into ordinary Flue tool definitions.

Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are replaced with underscores, and duplicate adapted names are rejected. Close the returned connection when its tools are no longer needed.

#### `McpServerOptions`

| Field                    | Type                         | Default             | Description                                                                      |
| ------------------------ | ---------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `url`                    | `string \| URL`              | —                   | MCP server endpoint.                                                             |
| `transport`              | `'streamable-http' \| 'sse'` | `'streamable-http'` | Remote MCP transport. Use `'sse'` for legacy servers.                            |
| `headers`                | `HeadersInit`                | —                   | Headers merged into MCP transport requests.                                      |
| `requestInit`            | `RequestInit`                | —                   | Additional MCP transport request configuration.                                  |
| `fetch`                  | `typeof fetch`               | —                   | Custom fetch implementation used by the MCP transport.                           |
| `timeoutMs`              | `number`                     | `60000`             | Per-request timeout in milliseconds for MCP requests.                            |
| `resetTimeoutOnProgress` | `boolean`                    | `false`             | Reset the per-request timeout whenever the server sends a progress notification. |

#### `McpServerConnection`

```ts
interface McpServerConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

| Field     | Description                                            |
| --------- | ------------------------------------------------------ |
| `name`    | Server name supplied to `connectMcpServer()`.          |
| `tools`   | MCP tools adapted into ordinary Flue tool definitions. |
| `close()` | Close the underlying MCP client connection.            |

## `createAgent(...)`

```ts
function createAgent<TPayload = unknown, TEnv = Record<string, any>>(
  initialize: (
    context: AgentCreateContext<TPayload, TEnv>,
  ) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): CreatedAgent<TPayload, TEnv>;
```

Creates an agent initializer. Default-export the returned value from an `agents/<name>.ts` module to define an addressable agent, or pass it to `ctx.init()` inside a workflow.

The initializer runs whenever the runtime initializes a harness from the created agent: when a workflow calls `ctx.init()`, and when the runtime prepares an addressable agent interaction. Do not treat it as a one-time constructor for a persistent agent instance id. Return a runtime config object with `model: '<provider>/<model>'`, `model: false`, or a profile with its own model field.

#### `AgentCreateContext`

| Field     | Type                    | Description                                                                 |
| --------- | ----------------------- | --------------------------------------------------------------------------- |
| `id`      | `string`                | Agent instance id, or workflow run id when initialized with `ctx.init()`.   |
| `env`     | `TEnv`                  | Platform environment bindings supplied by the runtime.                      |
| `payload` | `TPayload \| undefined` | Workflow payload when initialized with `ctx.init()`; otherwise `undefined`. |

#### `AgentRuntimeConfig`

| Field           | Type                        | Description                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`   | `string`                    | Optional organizational metadata describing what this agent does. Overrides the profile description when set. Per-initialization metadata only — for a static description that surfaces in the deployment manifest and `listAgents()`, use the module-level `description` export instead. |
| `profile`       | `AgentProfile`              | Reusable baseline profile. Created-agent fields replace or extend profile values.                                                                                                                                                                                                         |
| `model`         | `string \| false`           | Default model specifier. Set to `false` to require call-level model selection.                                                                                                                                                                                                            |
| `instructions`  | `string`                    | Instructions prepended to discovered workspace context.                                                                                                                                                                                                                                   |
| `skills`        | `Skill[]`                   | Additional registered skills available to initialized sessions.                                                                                                                                                                                                                           |
| `tools`         | `ToolDefinition[]`          | Additional custom model-callable tools available to initialized sessions.                                                                                                                                                                                                                 |
| `builtInTools`  | `BuiltInToolsConfig`        | Built-in model-callable tools available to initialized sessions. Omit for the full default set, set to `false` to disable all built-ins, or provide names to keep only those built-ins.                                                                                                   |
| `subagents`     | `AgentProfile[]`            | Additional named profiles available for delegated `session.task()` operations.                                                                                                                                                                                                            |
| `thinkingLevel` | `ThinkingLevel`             | Default reasoning effort. Individual operations may override this value.                                                                                                                                                                                                                  |
| `compaction`    | `false \| CompactionConfig` | Automatic conversation-compaction configuration. `false` disables threshold compaction; overflow recovery and explicit `session.compact()` calls still compact when needed.                                                                                                               |
| `durability`    | `DurabilityConfig`          | Durability configuration for durable agent submissions. Controls recovery attempt limits and submission timeouts.                                                                                                                                                                         |
| `cwd`           | `string`                    | Working directory inside the initialized sandbox.                                                                                                                                                                                                                                         |
| `sandbox`       | `SandboxFactory`            | Sandbox factory used to construct the initialized environment. Omit for the default in-memory sandbox; use `bash(...)` to wrap a custom just-bash factory (`BashFactory`). See [Sandboxes](/docs/guide/sandboxes/).                                                                       |

#### `CreatedAgent`

`CreatedAgent` is the opaque initializer value returned by `createAgent()`.

## `dispatch(...)`

```ts
function dispatch(agent: CreatedAgent, request: AgentDispatchRequest): Promise<DispatchReceipt>;

function dispatch(request: NamedAgentDispatchRequest): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  input: unknown;
}

interface NamedAgentDispatchRequest extends AgentDispatchRequest {
  agent: string;
}

interface DispatchReceipt {
  dispatchId: string;
  acceptedAt: string;
}
```

Accepts input for asynchronous delivery to a continuing agent instance. The created-agent overload requires a value default-exported by one discovered `agents/<name>.ts` module. The named overload selects a discovered agent module by name.

| Field        | Description                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `agent`      | Discovered agent module name for the named overload.                                                      |
| `id`         | Target agent instance id.                                                                                 |
| `input`      | Required JSON-like payload. Use `null` for an intentional empty payload. Flue snapshots it when accepted. |
| `dispatchId` | Generated delivery identifier returned in the receipt. This is not a workflow `runId`.                    |
| `acceptedAt` | ISO timestamp assigned when dispatch admission begins.                                                    |

`await dispatch(...)` resolves when the current runtime accepts and queues the input. It does not wait for model processing, tool calls, or an agent reply. Dispatched activity belongs to the continuing agent instance: it does not create workflow-run history and does not appear in `/runs` or `flue logs`.

Delivery durability depends on the generated target. Node uses a process-lifetime in-memory queue by default; with a durable `db.ts` adapter, dispatches survive restarts and are reconciled on the replacement process. Cloudflare durably admits delivery to the target agent Durable Object, orders it with direct prompts, and reconciles interruptions conservatively. Both targets retry only when replay safety is provable; external effects still require application-level idempotency. See [Durable Agents](/docs/concepts/durable-execution/) for recovery details, and [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) and [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for target-specific setup.

## `FlueContext`

```ts
interface FlueContext<TPayload = unknown, TEnv = Record<string, any>> {
  readonly id: string;
  readonly payload: TPayload;
  readonly env: TEnv;
  readonly req: Request | undefined;
  readonly log: FlueLogger;
  init(agent: CreatedAgent<TPayload, TEnv>, options?: AgentHarnessOptions): Promise<FlueHarness>;
}
```

The execution context passed to workflow handlers. Pass type parameters to type `payload` and `env` (for example, the `Env` interface generated by `wrangler types`). The typing is compile-time only — there is no runtime validation of `payload`.

| Member    | Type                   | Description                                                                              |
| --------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `id`      | `string`               | Workflow run/instance id, or the stable agent instance id during agent processing.       |
| `payload` | `TPayload`             | The invocation payload, snapshotted when the invocation is accepted.                     |
| `env`     | `TEnv`                 | Platform env bindings: `process.env` on Node.js, the Worker env on Cloudflare.           |
| `req`     | `Request \| undefined` | The standard Fetch `Request` for the current invocation. See [`ctx.req`](#ctxreq) below. |
| `log`     | `FlueLogger`           | Emit observable structured log events. See [`ctx.log`](#ctxlog) below.                   |
| `init`    | function               | Initialize a created agent for this invocation. See [`ctx.init(...)`](#ctxinit) below.   |

### `ctx.req`

The standard Fetch `Request` for the current invocation. Use it to read headers (`req.headers.get('authorization')`), method, URL, and the raw body (`req.text()` / `req.json()` / `req.arrayBuffer()` / `req.formData()`) — useful for things like HMAC signature verification over the request bytes.

Body access is single-use, like any standard `Request`: once you call a body-reading method, calling another will throw. Use `req.clone()` if you need to read it more than once.

`req` is `undefined` when the handler is invoked outside an HTTP context. Durable or recovered processing may receive a synthetic internal request instead of the original caller request, so authenticate and capture required transport metadata before durable admission; do not assume later processing retains the original headers, cookies, query parameters, URL, or body.

For the client IP, parse the platform header yourself — `req.headers.get('cf-connecting-ip')` on Cloudflare, or `req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` behind a trusted proxy on Node.js. Don't trust headers you don't control.

### `ctx.log`

```ts
interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

Emits observable structured log events with optional structured attributes. Log events are persisted in a run stream only during a workflow run. See [Observability](/docs/guide/observability/).

### `ctx.init(...)`

`ctx.init()` initializes a created agent for one workflow invocation. Each harness name may be initialized once per context. The default harness name is `'default'`.

#### `AgentHarnessOptions`

| Field       | Type               | Default     | Description                                                                    |
| ----------- | ------------------ | ----------- | ------------------------------------------------------------------------------ |
| `name`      | `string`           | `'default'` | Harness name.                                                                  |
| `tools`     | `ToolDefinition[]` | —           | Additional custom model-callable tools available to initialized sessions.      |
| `skills`    | `Skill[]`          | —           | Additional registered skills available to initialized sessions.                |
| `subagents` | `AgentProfile[]`   | —           | Additional named profiles available for delegated `session.task()` operations. |

## Agent

A created agent is the value returned by `createAgent()`. Addressable agents are default-exported from `agents/<name>.ts`. Workflows initialize a created agent with `ctx.init()`.

## Harness

A harness is an initialized agent environment returned by `ctx.init()`.

#### `FlueHarness`

Initialized agent environment returned by `ctx.init()`.

```ts
interface FlueHarness {
  readonly name: string;
  session(name?: string): Promise<FlueSession>;
  readonly sessions: FlueSessions;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  readonly fs: FlueFs;
}
```

### `harness.session(...)`

```ts
session(name?: string): Promise<FlueSession>;
```

Gets or creates a session in this harness. Defaults to the `'default'` session. Names beginning with `task:` are reserved for framework-owned detached task sessions.

### `harness.sessions.get(...)`

```ts
get(name?: string): Promise<FlueSession>;
```

Loads an existing session. Defaults to `'default'`. Rejects with `SessionNotFoundError` if it does not exist.

### `harness.sessions.create(...)`

```ts
create(name?: string): Promise<FlueSession>;
```

Creates a new session. Defaults to `'default'`. Rejects with `SessionAlreadyExistsError` if it already exists.

### `harness.sessions.delete(...)`

```ts
delete(name?: string): Promise<void>;
```

Deletes a session's stored conversation state. Defaults to `'default'`. No-op when missing. Rejects with `SessionBusyError` if the open session has an active operation. It also rejects while the session has accepted durable submissions queued or running. Session-management requests for one name are applied in request order.

### `harness.shell(...)`

```ts
shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
```

Runs a shell command in the harness sandbox without recording it in a conversation.

### `harness.fs`

- **Type:** `FlueFs`

Reads and writes files in the harness sandbox without recording them in a conversation.

## Session

A session is named conversation state inside a harness. A session runs one active `prompt`, `skill`, `task`, `shell`, or `compact` operation at a time. Use separate named sessions for parallel conversation branches.

#### `FlueSession`

Named conversation state inside a harness.

```ts
interface FlueSession {
  readonly name: string;
  prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
  skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
  task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  readonly fs: FlueFs;
  compact(): Promise<void>;
  delete(): Promise<void>;
}
```

The `prompt()`, `skill()`, and `task()` signatures above omit structured-result overloads. Pass a Valibot schema as `options.result` to resolve with validated `response.data`.

### `session.prompt(...)`

```ts
prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
```

Runs a model operation with a text instruction.

#### `PromptOptions`

| Field           | Type               | Description                                                           |
| --------------- | ------------------ | --------------------------------------------------------------------- |
| `result`        | Valibot schema     | Require validated structured data and resolve with `response.data`.   |
| `tools`         | `ToolDefinition[]` | Additional custom model-callable tools for this operation.            |
| `model`         | `string`           | Model specifier override for this operation.                          |
| `thinkingLevel` | `ThinkingLevel`    | Reasoning-effort override for this operation.                         |
| `signal`        | `AbortSignal`      | Cancel this operation.                                                |
| `images`        | `PromptImage[]`    | Images attached to the user message. Requires a vision-capable model. |

#### `PromptImage`

```ts
type PromptImage = {
  type: 'image';
  data: string;
  mimeType: string;
};
```

The selected model must support image input.

#### `PromptResponse`

```ts
interface PromptResponse {
  text: string;
  usage: PromptUsage;
  model: PromptModel;
}
```

#### `PromptUsage`

Aggregated token and cost usage for model work performed by one operation. Tool use, result retries, and automatic compaction may cause one operation to include multiple model turns.

#### `PromptModel`

```ts
interface PromptModel {
  provider: string;
  id: string;
}
```

Model selected for the operation's primary turn.

#### `PromptResultResponse`

```ts
interface PromptResultResponse<T> {
  data: T;
  usage: PromptUsage;
  model: PromptModel;
}
```

A structured-result operation throws `ResultUnavailableError` when the agent cannot produce validated data.

### `session.skill(...)`

```ts
skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;
```

Runs a registered skill. Pass `options.result` to require validated structured data instead of freeform text.

#### `SkillReference`

```ts
interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

Opaque imported packaged-skill reference accepted by `session.skill()`. Import a `SKILL.md` value rather than constructing one manually.

#### `SkillOptions`

| Field           | Type                      | Description                                                                   |
| --------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `args`          | `Record<string, unknown>` | Arguments included with the skill instruction.                                |
| `result`        | Valibot schema            | Require validated structured data and resolve with `response.data`.           |
| `tools`         | `ToolDefinition[]`        | Additional custom model-callable tools for this operation.                    |
| `model`         | `string`                  | Model specifier override for this operation.                                  |
| `thinkingLevel` | `ThinkingLevel`           | Reasoning-effort override for this operation.                                 |
| `signal`        | `AbortSignal`             | Cancel this operation.                                                        |
| `images`        | `PromptImage[]`           | Images attached to the skill's user message. Requires a vision-capable model. |

### `session.task(...)`

```ts
task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;
```

Delegates work to a detached child session. Pass `options.agent` to select a named subagent profile and `options.result` to require validated data. Completed child history remains parent-owned until the parent session is deleted or application-owned retention removes it.

#### `TaskOptions`

| Field           | Type               | Description                                                                          |
| --------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `agent`         | `string`           | Named subagent profile selected for this delegated task.                             |
| `result`        | Valibot schema     | Require validated structured data and resolve with `response.data`.                  |
| `tools`         | `ToolDefinition[]` | Additional custom model-callable tools for this operation.                           |
| `model`         | `string`           | Model specifier override for this operation.                                         |
| `thinkingLevel` | `ThinkingLevel`    | Reasoning-effort override for this operation.                                        |
| `cwd`           | `string`           | Working directory for the detached task session. Defaults to the parent session cwd. |
| `signal`        | `AbortSignal`      | Cancel this task.                                                                    |
| `images`        | `PromptImage[]`    | Images attached to the task's initial user message. Requires a vision-capable model. |

### `session.shell(...)`

```ts
shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
```

Runs a shell command and records its command exchange in conversation state.

#### `ShellOptions`

| Field       | Type                     | Description                                                                             |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `env`       | `Record<string, string>` | Environment variables supplied to the command.                                          |
| `cwd`       | `string`                 | Working directory supplied to the command.                                              |
| `timeoutMs` | `number`                 | Wall-clock deadline in milliseconds, forwarded to the sandbox adapter's native timeout. |
| `signal`    | `AbortSignal`            | Cancel this operation.                                                                  |

#### `ShellResult`

```ts
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

### `session.fs`

- **Type:** `FlueFs`

Reads and writes files in the session sandbox without recording them in the conversation transcript.

### `session.compact()`

```ts
compact(): Promise<void>;
```

Triggers conversation compaction immediately. Resolves without work when there is nothing to compact. Rejects when summarization fails or is aborted. Rejects with `SessionBusyError` if another operation is active on the session.

### `session.delete()`

```ts
delete(): Promise<void>;
```

Deletes this session's stored conversation state. Rejects with `SessionBusyError` while an operation is active. It also rejects while accepted durable submissions are queued or running for the session. Once deletion starts, the session is unusable and concurrent calls share the same deletion work.

#### `CallHandle<T>`

```ts
interface CallHandle<T> extends Promise<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
```

`prompt()`, `skill()`, `task()`, and `shell()` return awaitable call handles. Retain the handle when application code needs to cancel in-flight work. Aborting rejects the awaited operation with an `AbortError` (`DOMException`). Pass `options.signal` to merge an external abort signal with the handle's signal.

Other session failures reject with typed `FlueError` subclasses such as `SessionBusyError`, `SkillNotRegisteredError`, and `ModelNotConfiguredError`, all importable from `@flue/runtime`. See the [Errors Reference](/docs/api/errors-reference/) for the full vocabulary.

#### `FlueFs`

```ts
interface FlueFs {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

Paths may be absolute or relative. Relative paths use the configured `cwd`, or the sandbox adapter's default when `cwd` is omitted; use absolute paths for portability across sandbox adapters. These operations are out-of-band and do not appear in conversation history.

`writeFile()` creates missing parent directories automatically, in every sandbox mode — no prior `mkdir()` is needed before writing to a nested path.

#### `FileStat`

```ts
interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}
```

`isSymbolicLink`, `size`, and `mtime` are omitted when the sandbox adapter's provider does not expose them.
