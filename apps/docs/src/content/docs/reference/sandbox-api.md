---
title: Sandbox Adapter API
description: The contract for building a sandbox adapter — SandboxFactory, SessionEnv, the adapter tool factory, and the built-in sandbox factories.
lastReviewedAt: 2026-07-21
---

A sandbox adapter wraps an execution environment — a provider SDK, a container, the host machine, an in-memory emulation — into the factory contract that [`useSandbox(...)`](/docs/reference/agent-hooks-api/#usesandbox) accepts. This page documents that contract: the `SandboxFactory` interface, the `SessionEnv` surface an adapter must produce, the helpers that produce it from simpler shapes, the adapter tool factory, and the built-in factories. For choosing and using sandboxes, see the [Sandboxes guide](/docs/guide/sandboxes/); for the catalog of supported providers, see [Sandboxes in the Ecosystem](/docs/ecosystem/#sandboxes).

All symbols on this page are exported from `@flue/runtime`, except `local()` (from `@flue/runtime/node`) and `cloudflareSandbox()` (from `@flue/runtime/cloudflare`).

## `SandboxFactory`

```ts
interface SandboxFactory {
  createSessionEnv(options: { id: string }): Promise<SessionEnv>;
  tools?: SessionToolFactory;
}
```

The value passed to `useSandbox(...)` or composed into an agent's `sandbox:` config. The factory object itself is cheap to construct — agents build a fresh one on every render. All expensive work belongs inside `createSessionEnv()`.

- `createSessionEnv(options)` — builds the environment. Called once per initialized harness — one call per `init()` — and every session and task session of that harness shares the returned env. Re-renders never rebuild the environment. A rejection fails the agent's initialization.
- `options.id` — the agent instance id (`ctx.id`). Multiple harnesses initialized in the same context receive the same `id`, so an adapter that keys provider resources on `id` must tolerate repeated calls with the same value. Keying a provider workspace on `id` is how a conversation gets a durable filesystem across messages and restarts.
- `tools` — optional. When present, replaces the framework's default model-facing tool set for this sandbox. See [`SessionToolFactory`](#sessiontoolfactory).

A minimal adapter over a provider SDK, using [`createSandboxSessionEnv`](#createsandboxsessionenvapi-cwd) to supply the generic path and abort plumbing:

```ts
import { createSandboxSessionEnv, type SandboxApi, type SandboxFactory } from '@flue/runtime';

export function myProvider(client: MyProviderClient): SandboxFactory {
  return {
    async createSessionEnv({ id }) {
      const sandbox = await client.findOrCreate(id);
      const api: SandboxApi = {/* map each SandboxApi method to the provider SDK */};
      return createSandboxSessionEnv(api, '/workspace');
    },
  };
}
```

What the contract deliberately does not include:

- **No teardown verb.** There is no `dispose()` or lifecycle callback. Flue connects to what the factory hands it and never creates, reuses, or destroys provider infrastructure on its own — provisioning and deletion belong to the application (typically inside the factory, or in application code around it). An adapter must not call the provider's `delete()`/`terminate()`/`kill()` on the application's behalf.
- **No per-message rebuild.** The environment is resolved once per initialized harness. An adapter cannot observe individual messages or turns.
- **No identity beyond `id`.** The factory receives the instance id and nothing else — no conversation content, no request data. Anything else an adapter needs must be captured in the closure that built the factory.

### `useSandbox` `cwd` scoping

When the agent passes `useSandbox(factory, { cwd })`, the runtime wraps the adapter's env in a scoping layer after `createSessionEnv()` resolves. The adapter is not involved and must not apply an agent's `cwd` itself:

- The `cwd` value is resolved through the adapter env's own `resolvePath` (so a relative value resolves against the adapter's base directory), then POSIX-normalized.
- The wrapper resolves all relative file paths against the scoped `cwd`, defaults `exec`'s working directory to it, and resolves a relative per-call `exec` `cwd` against it.
- The wrapper exposes only the standard `SessionEnv` members. Extra properties an adapter attached to its env (a [native surface](#extending-sessionenv)) are not forwarded — agents that need the native surface must not set a `cwd` override on `useSandbox`.

## `SessionEnv`

```ts
interface SessionEnv {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult>;

  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  cwd: string;
  resolvePath(p: string): string;
}
```

The universal environment interface. Every sandbox mode — virtual, local, remote — implements it, so core logic never branches on mode. The same object is exposed to application code as [`harness.sandbox`](/docs/reference/agent-api/#harnesssandbox), and the standard model-facing tools operate through it. Operations on it are never recorded in the conversation.

Most adapters should not implement this interface by hand: [`createSandboxSessionEnv`](#createsandboxsessionenvapi-cwd) (over a provider SDK) and [`bash()`](#bashfactory) (over a just-bash instance) produce conforming envs from smaller surfaces. The contract below is what those wrappers guarantee, and what a hand-written implementation must reproduce.

### Path semantics

- Paths are POSIX-style, `/`-separated. (`local()` on Windows uses host path semantics.)
- Every file method accepts both absolute and relative paths. Relative paths resolve against `cwd`.
- `cwd` — the environment's working directory, as an absolute path. Workspace discovery (the directory listing, `AGENTS.md`, `.agents/skills/`) and default command execution happen here.
- `resolvePath(p)` — resolves a relative path against `cwd` without touching the filesystem; absolute paths pass through. File methods resolve internally — callers need `resolvePath` only when their own logic wants the absolute path. The standard `write`/`edit` tools also use it to key per-file mutation locks, so two spellings of the same path must resolve to the same string.

### `exec`

Runs a shell command and resolves with its output.

- Resolves with a `ShellResult` for any completed command, non-zero exit codes included. Rejections are reserved for transport failures and aborts.
- `options.cwd` — working directory for this command. A relative value resolves against `env.cwd`; when omitted, the command runs in `env.cwd`.
- `options.env` — environment variables supplied to the command, layered on top of whatever base environment the adapter defines.
- `options.timeoutMs` — wall-clock deadline hint in milliseconds, and the primary cancellation contract. Forward it to the provider's native timeout option (E2B `timeoutMs`, Daytona `timeout`, Modal `timeout`, and so on) so signal-blind providers still observe the deadline. Providers with coarser granularity may round the value up, never down.
- `options.signal` — mid-flight cancellation for adapters whose SDK supports it. Aborting rejects with an `AbortError` (`DOMException`) carrying the signal's reason as `cause`. Adapters that cannot honor it mid-flight may ignore it; the wrappers below still check the signal before and after the remote call, so a pre-aborted call never executes and a completed-during-abort call still rejects.
- `timeoutMs` and `signal` are independent. Callers with a deadline that also want ad-hoc cancellation pass both; adapters that support both should observe whichever fires first. The standard `bash` tool passes both whenever the model requests a timeout.

### File verbs

- `readFile(path)` — reads a UTF-8 file. Throws if the path does not exist or is not a file.
- `readFileBuffer(path)` — reads raw bytes.
- `writeFile(path, content)` — creates or replaces a file. Must create missing parent directories — this is a cross-mode guarantee (`fs.writeFile('out/nested/report.md', …)` never requires a prior `mkdir`). `createSandboxSessionEnv`, `bash()`, and `local()` all implement it by retrying a failed write once after `mkdir -p` on the parent; a hand-written env must provide the same guarantee.
- `stat(path)` — file metadata. Throws if the path does not exist.
- `readdir(path)` — directory entry names (names only, no paths). Throws if the path is not a directory.
- `exists(path)` — `true` if a file or directory exists. Never throws.
- `mkdir(path, options)` — creates a directory; `recursive` creates missing parents and tolerates an existing directory.
- `rm(path, options)` — removes a file or directory; `recursive` removes directory contents, `force` suppresses the missing-path error. An adapter whose provider cannot honor a requested option must throw [`SandboxOperationUnsupportedError`](#sandboxoperationunsupportederror) before modifying anything — never silently ignore an option or leave its behavior provider-defined.

Errors thrown by file verbs surface to the model as tool errors, so messages should be factual and self-contained (the standard tools pass them through).

### `ShellResult`

```ts
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

### `FileStat`

```ts
interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}
```

- `isSymbolicLink`, `size`, and `mtime` are omitted when the provider does not expose them. Adapters must never fabricate placeholder values (`new Date()`, `0`, `false`) — callers cannot distinguish them from real metadata.
- For symlinks, `isFile`/`isDirectory`/`size`/`mtime` describe the target and `isSymbolicLink` describes the path itself (the semantics of `stat -L` plus a non-following check; `local()` and the Cloudflare Sandbox adapter both implement this).

### Extending `SessionEnv`

An adapter may return an env with additional properties — a native surface beyond the generic verbs. `harness.sandbox` exposes the object exactly as returned, so an adapter package can ship a runtime-checked accessor that narrows to it (the Cloudflare Shell adapter's `shellWorkspace(harness.sandbox)` returns its `Workspace` this way). Two constraints:

- A `cwd` override on `useSandbox` wraps the env and drops extra properties ([above](#usesandbox-cwd-scoping)).
- An env that cannot execute commands should still ship all file verbs and throw from `exec` — and pair the sandbox with a [`tools`](#sessiontoolfactory) list that omits the exec-backed standard tools.

## `createSandboxSessionEnv(api, cwd)`

```ts
function createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv;
```

Wraps a `SandboxApi` — the minimal surface a remote provider adapter implements — into a conforming `SessionEnv`. The wrapper supplies:

- Path resolution: relative file paths and relative/absent `exec` working directories resolve against `cwd`, POSIX-normalized. The `api` methods always receive absolute paths.
- The `writeFile` parent-creation guarantee: a failed write is retried once after `api.mkdir(parent, { recursive: true })`; when the retry still fails, the retried write's error propagates.
- Abort checks around `exec`: an already-aborted signal rejects with `AbortError` before `api.exec` is called, and an abort that fires during a signal-blind remote command rejects after it returns instead of surfacing a stale success. The adapter only needs to wire `signal` into its SDK when the SDK supports mid-flight cancellation.

### `SandboxApi`

```ts
interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult>;
}
```

Identical to the corresponding `SessionEnv` members except that paths arrive pre-resolved (absolute) and the `writeFile` parent guarantee is handled by the wrapper.

File-verb implementation notes:

- `writeFile` — accept both `string` and `Uint8Array`; convert strings to UTF-8 bytes for a provider that only accepts buffers. Let a missing-parent error propagate — the wrapper retries after `mkdir(parent, { recursive: true })`, so adapter-side parent creation is redundant.
- `readFileBuffer` — return a `Uint8Array`; wrap a Node `Buffer` with `new Uint8Array(buffer)`.
- `exists` — must not throw. Most provider SDKs throw for a missing path; catch and return `false`.
- `mkdir` — a provider SDK that only supports single-level creation may implement `recursive` with `exec('mkdir -p …')`.
- `rm` — implement `recursive` and `force` exactly, or throw [`SandboxOperationUnsupportedError`](#sandboxoperationunsupportederror) before any mutation. A direct filesystem adapter must not shell out solely to emulate unsupported removal flags; an adapter that already runs other verbs through the shell implements the flags with `rm` there too — shell semantics match Node's `fs.rm` exactly (`-f` resolves on a missing path, `-r` without `-f` fails on one, `-f` on a directory still errors).

`exec` implementation contract:

- Honor `timeoutMs` by forwarding it to the provider SDK's native timeout option, converting units and rounding up — never down — when the provider is coarser (a whole-seconds provider forwards `Math.ceil(timeoutMs / 1000)`).
- An adapter that enforces the deadline itself resolves an expired command as a `ShellResult` with `exitCode: 124` and the timeout details on `stderr` — the `timeout(1)` convention the shipped adapters follow. Rejection stays reserved for `signal` aborts.
- Forward `signal` only when the SDK has a real cancellation primitive (an `AbortSignal` option, a process kill, a cancel token). Do not simulate mid-flight cancellation with `Promise.race` — the remote process keeps running. The wrapper's pre- and post-call abort checks already cover signal-blind SDKs.
- When the provider does not expose `stderr` separately, return `''` for it. Report `exitCode: 0` only for a clearly successful call.

Liveness contract (all `SandboxApi` methods):

- An adapter should ensure in-flight operations settle when the sandbox dies, by whatever mechanism its provider SDK supports — native rejection of in-flight calls, or polling a cheap control-plane status read while a call is pending. The first-party Cloudflare adapter implements the polling shape internally.
- An adapter with no such mechanism carries an accepted limitation: when the provider transport never settles a call after the sandbox dies, that call may hang until the surrounding operation is aborted.
- There is deliberately no per-command deadline in this contract. Agent commands are legitimately unbounded; `timeoutMs` is the command's own deadline, not an infrastructure liveness bound.
- An adapter that detects sandbox death should reject with `SandboxDiedError` (`type: 'sandbox_died'`, exported from `@flue/runtime`), so shell classification reports an infrastructure failure rather than caller cancellation.

## `bash(factory)`

```ts
function bash(factory: BashFactory): SandboxFactory;

type BashFactory = () => BashLike | Promise<BashLike>;
```

Wraps a [just-bash](https://github.com/vercel-labs/just-bash) `Bash` instance into a `SandboxFactory` — the in-memory [virtual sandbox](/docs/guide/sandboxes/#the-virtual-sandbox) (seeded files, a network allowlist, custom commands).

- The factory function is called once, when the runtime initializes the agent.
- The returned value is duck-type checked (`exec`, `getCwd`, and an `fs` object). A wrong value throws `Error('[flue] BashFactory must return a Bash-like object.')`.
- The env's `cwd` is the instance's `getCwd()` (just-bash defaults to `/home/user` when constructed without `cwd` or `files`).
- just-bash has no native timeout option, so the wrapper translates `exec`'s `timeoutMs` into an `AbortSignal` and merges it with the caller's signal. Pre- and post-call abort checks apply as in `createSandboxSessionEnv`.
- The `writeFile` parent-creation guarantee is applied over the instance's `fs`.

`BashLike` is a structural type (no just-bash import in `@flue/runtime`), exported for adapter authors who construct compatible runtimes:

```ts
interface BashLike {
  exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ShellResult>;
  getCwd(): string;
  fs: {
    readFile(path: string, options?: any): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array, options?: any): Promise<void>;
    stat(path: string): Promise<any>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    resolvePath(base: string, path: string): string;
  };
}
```

## `SessionToolFactory`

```ts
type SessionToolFactory = (env: SessionEnv, options: SessionToolFactoryOptions) => AgentTool<any>[];

interface SessionToolFactoryOptions {
  subagents: Record<string, SubagentDefinition>;
}
```

An optional `tools` function on a `SandboxFactory`. When present, its return value **replaces** the framework's default six-tool set (`read`, `write`, `edit`, `bash`, `grep`, `glob`) for agents on this sandbox. Compose the replacement from the [standard tool factories](#the-standard-tool-factories) plus the sandbox's own native tools rather than rebuilding from scratch — an exec-less sandbox, for example, lists the three file tools and its own executor tool.

- Must be synchronous and return a fresh array on every call. It is invoked each time the runtime assembles the model's tool list — at initialization and again at every turn boundary — not once.
- `env` — the session environment, with the [packaged-skill overlay](#packaged-skill-overlays) layered onto `readFile`. This is not the identical object `harness.sandbox` exposes; tools that hold the env in a closure read packaged-skill paths transparently.
- `options.subagents` — the agent's current subagent roster, keyed by name. Provided for adapters whose tools describe or constrain delegation.

The replacement covers only the framework's built-in group. Unaffected by it:

- The framework group — `task` (always present), `activate_skill` (when any skill is mounted), and `read_skill_resource` (when a mounted packaged skill carries supporting files) — is appended separately.
- Custom tools from `useTool(...)` / `defineTool(...)` and per-call result tools are added separately.

Tool names must be unique across all groups, and the names `task`, `activate_skill`, `read_skill_resource`, `finish`, and `give_up` are framework-reserved. A collision throws [`ToolNameConflictError`](/docs/reference/errors/#toolnameconflicterror) when the tool list is assembled.

The element type is `AgentTool` from `@earendil-works/pi-agent-core` (a dependency of `@flue/runtime`; the type is not re-exported). Structurally:

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters; // TypeBox schema
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: (partial: AgentToolResult<TDetails>) => void,
  ): Promise<AgentToolResult<TDetails>>; // { content, details, terminate? }
}
```

`execute` throws on failure rather than encoding errors in `content`. The standard factories return values of this type; typing a factory as `SessionToolFactory` checks a hand-written tool against it.

## The standard tool factories

```ts
function createReadTool(env: SessionEnv): AgentTool;
function createWriteTool(env: SessionEnv): AgentTool;
function createEditTool(env: SessionEnv): AgentTool;
function createBashTool(env: SessionEnv): AgentTool;
function createGrepTool(env: SessionEnv): AgentTool;
function createGlobTool(env: SessionEnv): AgentTool;
```

One factory per standard model-facing tool, each closing over a `SessionEnv`. These are exactly the tools the framework installs when a sandbox has no `tools` function; exporting them per-tool lets an adapter's `SessionToolFactory` add, drop, or swap members without rebuilding the set. `createReadTool`, `createWriteTool`, and `createEditTool` need only the file verbs; `createBashTool`, `createGrepTool`, and `createGlobTool` require a working `env.exec`.

### `createReadTool(env)`

The `read` tool. Reads via `env.readFile`; output is truncated to 2000 lines or 50 KB, whichever is hit first.

- `path` — file to read.
- `offset` — line number to start from, 1-indexed. Optional. An offset past the end of the file throws.
- `limit` — maximum number of lines. Optional.

Truncated output ends with a marker naming the shown line range and the offset to continue from.

### `createWriteTool(env)`

The `write` tool. Writes via `env.writeFile` (parent directories created per the env guarantee).

- `path` — file to write.
- `content` — full file content.

Same-file mutations within one parallel tool batch are serialized through a per-resolved-path lock shared with `edit`, so a shorter write finishing after a longer one cannot leave corrupt tail bytes. Paths are canonicalized through `env.resolvePath`; a `bash` command mutating the same file concurrently is not synchronized.

### `createEditTool(env)`

The `edit` tool. Exact-text replacement: reads the file, replaces, writes back — the whole transaction under the same per-path lock as `write`.

- `path` — file to edit.
- `oldText` — exact text to find. An empty string throws. Zero occurrences throws a "could not find" error; more than one occurrence throws and asks for more context, unless `replaceAll` is set.
- `newText` — replacement text.
- `replaceAll` — replace every occurrence. Optional.

### `createBashTool(env)`

The `bash` tool. Executes via `env.exec`; stdout and stderr are combined and truncated to the last 2000 lines or 50 KB.

- `command` — the shell command.
- `timeout` — deadline in **seconds** (model-facing convention). Optional. Converted to `timeoutMs` for the env, and additionally composed into the abort signal as a backstop for envs that ignore both cancellation fields.

On timeout, the tool returns a recoverable `ShellResult`-shaped output with `exitCode: 124` and the message `[flue] Command timed out after N seconds.` — the model can react to it. On host abort it rethrows, so the outer operation cancels.

### `createGrepTool(env)`

The `grep` tool. Searches file contents by running `rg` — or `grep -rnH` where `rg` is unavailable — through `env.exec`. The backend is probed once per environment (`rg --version`, 10-second deadline) and cached.

- `pattern` — regex to search for.
- `path` — directory or file to search. Optional; defaults to `.`.
- `include` — glob filter, e.g. `"*.ts"`. Optional.
- `literal` — match the pattern as literal text. Optional.

Output is capped at 100 matches; individual lines are truncated to 500 characters. A backend exit code above 1 throws with the backend's stderr.

### `createGlobTool(env)`

The `glob` tool. Finds files by name pattern with `find <path> -type f -name <pattern>` through `env.exec`.

- `pattern` — filename pattern with `find -name` semantics.
- `path` — directory to search. Optional; defaults to `.`.

Results are capped at 1000 paths.

## Packaged-skill overlays

Supporting files of a [packaged skill](/docs/guide/skills/#supporting-files-at-runtime) live in the application bundle, not the sandbox. The runtime serves them at virtual paths under `/.flue/packaged-skills/<skill-id>/…`, and it does so by layering an overlay onto the env it hands to tool factories — never by writing into the adapter's filesystem.

- The env passed to every tool factory (standard and adapter alike) has `readFile` wrapped: paths under `/.flue/packaged-skills/` resolve from the in-memory skill catalog, everything else delegates to the adapter. Adapters need no special-casing; any tool that reads through its env resolves skill paths transparently.
- An unknown path under that root throws `Error('[flue] Packaged skill file not found: <path>')` instead of reaching the adapter.
- Binary skill files are served as base64 text, wrapped to 76-character lines.
- The overlay is session-internal. `harness.sandbox` and `useTool` handlers see the adapter's real env; the virtual root is not visible there.
- Only `readFile` is overlaid. `exec`, `exists`, `stat`, and the other verbs pass straight through, so shell commands cannot see the virtual root — the standard `read` tool (or the framework's `read_skill_resource` tool) is the access path.

## Built-in factories

### `local(options?)`

```ts
import { local } from '@flue/runtime/node';

function local(options?: LocalSandboxOptions): SandboxFactory;

interface LocalSandboxOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}
```

Node target only. Binds the agent directly to the host: file verbs call `node:fs/promises`, and `exec` spawns real processes. There is no isolation — see the [Node target guide](/docs/guide/node-target/#local-sandbox) for when that is appropriate.

- `cwd` — working directory. Defaults to `process.cwd()`; resolved to an absolute host path.
- `env` — variables layered on top of the default allowlist. Set a key to `undefined` to drop a default. A non-record value (an array, `true`) throws a `TypeError` at construction. Per-call `exec` `env` layers on top of the result.

Environment allowlist: the model's shell does not inherit `process.env`. Only `PATH`, `HOME`, `USER`, `LOGNAME`, `HOSTNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR`, `TMP`, and `TEMP` pass through by default; everything else is a per-variable opt-in via `options.env`. The snapshot is taken once at construction — later mutations of `process.env` are not picked up. `env: { ...process.env }` inherits everything, host secrets included.

`exec` behavior:

- Commands run through real `bash` when present (probed once per process, resolved to an absolute path), falling back to the platform default shell (`/bin/sh` or, on Windows, the system shell) when it is not.
- On POSIX the child leads its own process group; abort and timeout signal the whole group — `SIGTERM`, escalating to `SIGKILL` after a 2-second grace — so compound commands cannot orphan grandchildren.
- Non-zero exits, signal deaths, and spawn failures all resolve as `ShellResult` (spawn failures as `exitCode: 1` with the error message on stderr). Aborts reject with `AbortError`.
- Captured output is capped at 64 MiB; exceeding it kills the process tree and resolves with `exitCode: 1` and a truncation note on stderr.
- `timeoutMs` is composed into the abort signal (there is no separate native timeout).

`stat` reports `isFile`/`isDirectory`/`size`/`mtime` for the symlink target and `isSymbolicLink` for the path itself. All `FileStat` fields are populated.

### `cloudflareSandbox(sandbox, options?)`

```ts
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

function cloudflareSandbox(
  sandbox: CloudflareSandboxStub,
  options?: CloudflareSandboxOptions,
): SandboxFactory;

interface CloudflareSandboxOptions {
  cwd?: string;
}
```

Cloudflare target. Wraps a `@cloudflare/sandbox` Durable Object stub (the value `getSandbox()` returns) into a `SandboxFactory`. `CloudflareSandboxStub` is structural, so `@flue/runtime` does not depend on `@cloudflare/sandbox`.

- `cwd` — working directory inside the container. Defaults to `/workspace`.

See [Cloudflare Sandbox](/docs/guide/cloudflare-target/#cloudflare-sandbox) in the target guide and the [ecosystem entry](/docs/ecosystem/sandboxes/cloudflare/).

## `SandboxOperationUnsupportedError`

```ts
class SandboxOperationUnsupportedError extends FlueError {
  constructor(input: { operation: string; provider: string; options: readonly string[] });
}
```

The error an adapter throws when a caller requests an operation with options the provider cannot honor (`type: 'sandbox_operation_unsupported'`). Throw it before modifying the filesystem, so the rejection guarantees nothing changed. `operation` names the verb, `provider` the sandbox product, and `options` the specific option names that could not be honored; all three are preserved on the error's `meta`. See [Errors — `SandboxOperationUnsupportedError`](/docs/reference/errors/#sandboxoperationunsupportederror).
