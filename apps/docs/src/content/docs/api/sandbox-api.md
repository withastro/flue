---
title: Sandbox Adapter API
description: Adapt a provider sandbox SDK into Flue's public sandbox contract.
---

A sandbox adapter adapts a third-party sandbox provider's SDK into Flue's `SandboxFactory` interface so that agents can run shell commands and read or write files inside that sandbox.

If you are a coding agent building a sandbox adapter for a user, follow this document literally and produce one TypeScript file that exports a factory function such as `daytona(...)` returning a `SandboxFactory`.

## High-level shape

A sandbox adapter is one TypeScript file. It exports a factory function that takes an already-initialized provider sandbox plus options and returns a `SandboxFactory`. Flue calls `factory.createSessionEnv({ id })` once per initialized harness and uses the returned `SessionEnv` for all shell and file operations.

```ts
// <source-dir>/sandboxes/<provider>.ts
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as ProviderSandbox } from '<provider-sdk>';

class ProviderSandboxApi implements SandboxApi {
  constructor(private sandbox: ProviderSandbox) {}
  // Implement every method on SandboxApi.
}

export function provider(sandbox: ProviderSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/workspace';
      const api = new ProviderSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Sandbox adapters are pure adapters. They map a provider sandbox to a `SessionEnv` rooted at the provider-owned base cwd and stop there. They must not apply an agent runtime config's `cwd`: Flue resolves that value once against the adapter's base cwd during `init()`. Sandbox adapters do not manage the sandbox's lifetime. The user owns what they create.

## Imports

Import these from `@flue/runtime`:

- `createSandboxSessionEnv(api, cwd)` wraps your `SandboxApi` into a `SessionEnv` that Flue can drive. Pass the provider-owned base cwd, not the runtime config's cwd.
- `SandboxApi` is the interface you implement.
- `SandboxFactory` is what your factory returns.
- `SessionToolFactory` is the optional model-facing tool factory type for a custom sandbox.
- `SessionEnv` is what `createSandboxSessionEnv` returns. Do not construct one yourself.
- `FileStat` is the return type for `stat()`.
- `SandboxOperationUnsupportedError` rejects filesystem options that a provider cannot implement exactly.

Do not import internal runtime paths. `@flue/runtime` is the public surface for adapter authors.

## TypeScript contracts

Always typecheck against the real types from `@flue/runtime`. If this page drifts from the runtime package, the runtime package wins.

### `SandboxApi`

```ts
export interface SandboxApi {
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

`timeoutMs` is the primary cancellation contract. Every adapter should honor it by forwarding to the provider SDK's native timeout option. `signal` is optional: adapters whose provider SDK supports mid-flight cancellation should forward it; others may ignore it.

### `SandboxFactory`

```ts
export interface SandboxFactory {
  createSessionEnv(options: { id: string }): Promise<SessionEnv>;
  tools?: SessionToolFactory;
}
```

`createSessionEnv` is called once per initialized harness — one call per `init()` — and every session and task session of that harness shares the returned `SessionEnv`. The `id` option is the context id (`ctx.id`): the agent instance id for direct agent requests, or the workflow run id inside a workflow. Multiple harnesses initialized in the same context receive the same `id`, so an adapter that keys provider resources on `id` must tolerate repeated calls with the same value.

`tools` replaces the framework's default model-facing tool list for this sandbox. Omit it for the standard filesystem and shell tools.

### `SessionToolFactory`

```ts
export type SessionToolFactory = (
  env: SessionEnv,
  options: { subagents: Record<string, AgentProfile> },
) => AgentTool<any>[];
```

Use this optional factory when the sandbox exposes provider-specific model-facing tools. Flue appends the `task` tool separately.

### `FileStat`

```ts
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}
```

### `SessionEnv`

Return a `SessionEnv` from `createSessionEnv`, but get it from `createSandboxSessionEnv(api, cwd)`. Do not write `SessionEnv` methods by hand in an adapter.

## Required `SandboxApi` methods

Implement every method below. If your provider SDK does not have a direct analogue for an operation, use a shell command only when shell execution is the adapter's normal filesystem mechanism. Do not add option-specific shell workarounds around an otherwise direct filesystem API. Reject options that the direct API cannot honor exactly before mutation.

### `readFile(path)`

UTF-8 decode the file at `path` and return its contents.

### `readFileBuffer(path)`

Return raw bytes as a `Uint8Array`. If the SDK gives you a Node `Buffer`, wrap it with `new Uint8Array(buffer)`.

### `writeFile(path, content)`

Write `content` to `path`. Accept both `string` and `Uint8Array`. Convert strings to UTF-8 bytes before sending them to providers that only accept buffers.

Sandbox adapters need not create parent directories; the runtime guarantees it. When a write fails, `createSandboxSessionEnv` calls your `mkdir(parent, { recursive: true })` and retries the write once, so `FlueFs.writeFile` behaves identically across every sandbox mode. Let missing-parent errors from the provider propagate — do not add your own parent creation.

### `stat(path)`

Return a `FileStat`. `isFile` and `isDirectory` are required. If the provider SDK does not expose modification time, size, or symlink information, omit those fields — never fabricate placeholder values such as `new Date()`, `0`, or `false`, since callers cannot distinguish them from real metadata.

### `readdir(path)`

Return names, not full paths, for entries in the directory.

### `exists(path)`

Return `true` when the path exists. Most providers throw for missing paths, so catch that error and return `false`.

### `mkdir(path, options?)`

Create a directory. If `options.recursive` is set, create parents as needed. If the provider SDK only supports a single-level operation, fall back to `exec('mkdir -p ...')` for the recursive case.

### `rm(path, options?)`

Delete a file or directory. Implement `options.recursive` and `options.force` exactly or reject unsupported requested options with `SandboxOperationUnsupportedError` before any mutation. Never ignore an option or leave its behavior provider-defined. A direct filesystem adapter must not shell out only to emulate unsupported removal flags; shell-native adapters may continue to implement removal through their normal shell filesystem path.

### `exec(command, options?)`

Run a shell command. Honor `options.cwd`, `options.env`, and `options.timeoutMs`. The `timeoutMs` hint is measured in milliseconds. Forward it to the provider SDK's native timeout option, converting units when the provider uses something other than milliseconds. Implementations MAY round `timeoutMs` UP to their coarsest supported granularity, never down: a provider that only accepts whole seconds should use `Math.ceil(options.timeoutMs / 1000)` so the enforced deadline is never shorter than the requested one. If the provider SDK does not expose a native timeout option, translate the hint into `AbortSignal.timeout(options.timeoutMs)` and pass that signal to an SDK that accepts one, or as a last resort race the call against a timer and reject. Make a best-effort attempt to honor `timeoutMs`: it is how the model-facing bash tool stops a command and retries. Returning an exit-code-124 result with timeout details in `stderr` matches the convention used by other adapters and `timeout(1)`.

If the provider SDK also supports an `AbortSignal`, forward `options.signal` for true mid-flight cancellation. If it cannot observe a signal, ignore that option. The `createSandboxSessionEnv` wrapper performs pre- and post-operation `signal.aborted` checks. Do not fake mid-flight signal cancellation with `Promise.race`: the underlying remote process would keep running.

The Daytonan adapter demonstrates the rounding rule: Daytona's `executeCommand` accepts whole seconds, so it forwards `Math.ceil(options.timeoutMs / 1000)`.

If the provider does not separately expose `stderr`, return `''`. Default `exitCode` to `0` only when the call clearly succeeded.

## Sandbox lifetime

Flue does not manage sandbox lifetime. The user creates the sandbox and decides when or whether to delete it. Sandbox adapters must not call `sandbox.delete()`, `sandbox.terminate()`, `sandbox.kill()`, or any equivalent on the user's behalf.

Sandbox adapter factories therefore take no `cleanup` option, and `createSandboxSessionEnv` takes no cleanup callback. If the adapter opens a real socket such as SSH, it may manage that socket internally, but it must not assume Flue will trigger teardown.

## Reference implementation

See the deployed [Daytona blueprint](https://flueframework.com/cli/blueprints/daytona.md) for a complete implementation. It demonstrates explicit rejection of unsupported `force` removal, `exists()` error handling, and buffer or string conversion in `writeFile()`.

## Sandbox adapter file location

The user's project root does not change. The selected source directory inside it may vary. Flue selects the first existing directory in this order:

1. `<root>/.flue/`
2. `<root>/src/`
3. `<root>/`

Write the adapter to `<source-dir>/sandboxes/<name>.ts`. If the selected source directory is unclear, ask the user before writing.

## Verify a generated sandbox adapter

Before finishing:

1. Typecheck the file with `npx tsc --noEmit` or the project's existing typecheck command.
2. Confirm that the adapter imports from `@flue/runtime`.
3. If the project does not depend on the provider SDK, tell the user to install it.
4. Tell the user which environment variables they need to set.
5. Show a minimal snippet wiring the adapter into an agent.
