<!--
  DO NOT MOVE OR RENAME THIS FILE.

  This document is the canonical spec for Flue sandbox connectors. It is
  referenced by:
    - connectors/sandbox.md (the generic sandbox connector instructions)
    - The `flue add <url> --category sandbox` flow in packages/cli/bin/flue.ts
    - Any agent that fetches the raw GitHub URL below to read the spec.

  Raw GitHub URL (must remain valid):
    https://raw.githubusercontent.com/withastro/flue/refs/heads/main/docs/sandbox-connector-spec.md

  If you must move this file, update connectors/sandbox.md to point at the new
  location.
-->

# Flue Sandbox Connector Spec

This document is the contract for building a Flue sandbox connector. A sandbox
connector adapts a third-party sandbox provider's SDK (Daytona, E2B, Modal,
Cloudflare Containers, your in-house infra, etc.) into Flue's `SandboxFactory`
interface so that Flue agents can run shell commands and read/write files
inside that sandbox.

If you are an AI agent reading this to build a connector for a user, follow
this document literally and end up with a single TypeScript file that exports
a factory function (e.g. `daytona(...)`) returning a `SandboxFactory`.

---

## High-Level Shape

A connector is one TypeScript file. It exports a factory function that takes
an already-initialized provider sandbox plus options, and returns a
`SandboxFactory`. Flue calls `factory.createSessionEnv({ id, cwd })` once per
session and uses the returned `SessionEnv` for all shell/file operations.

```ts
// .flue/connectors/<provider>.ts (or ./connectors/<provider>.ts)
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type {
  SandboxApi,
  SandboxFactory,
  SessionEnv,
  FileStat,
} from '@flue/sdk/sandbox';
import type { Sandbox as ProviderSandbox } from '<provider-sdk>';

class ProviderSandboxApi implements SandboxApi {
  constructor(private sandbox: ProviderSandbox) {}
  // ... implement every method on SandboxApi (see "Required SandboxApi Methods" below)
}

export function provider(sandbox: ProviderSandbox): SandboxFactory {
  return {
    async createSessionEnv({ cwd }): Promise<SessionEnv> {
      const sandboxCwd = cwd ?? '/workspace'; // pick a sensible default
      const api = new ProviderSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Connectors are pure adapters. They map a provider sandbox to `SessionEnv`
and stop there. They do not manage the sandbox's lifetime — the user owns
what they create.

---

## Imports You Will Use

All from `@flue/sdk/sandbox`:

- `createSandboxSessionEnv(api, cwd)` — wraps your `SandboxApi` into a
  `SessionEnv` that Flue can drive.
- `SandboxApi` — the interface you implement.
- `SandboxFactory` — what your factory returns.
- `SessionEnv` — what `createSandboxSessionEnv` returns. You don't construct
  this yourself.
- `FileStat` — the return type for `stat()`.

Do **not** import internal SDK paths. `@flue/sdk/sandbox` is the only public
surface for connector authors.

---

## TypeScript Contracts (snapshot)

These are the exact shapes you must conform to. Always typecheck against the
real types from `@flue/sdk/sandbox` — if there's any drift between this
document and the SDK, **the SDK wins**.

### `SandboxApi` (you implement this)

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
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

`timeout` is the **primary** cancellation contract — every connector should
honor it by forwarding to the provider SDK's native timeout option.
`signal` is an *optional* enhancement: connectors whose provider SDK
supports mid-flight cancellation (e.g. accepts an `AbortSignal`) should
forward it; others may ignore it. See "Cancellation" below.

### `SandboxFactory` (your factory returns this)

```ts
export interface SandboxFactory {
  createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
}
```

### `FileStat`

```ts
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
}
```

### `SessionEnv` (you do **not** implement this)

You return one of these from `createSessionEnv`, but you get it from
`createSandboxSessionEnv(api, cwd)`. You never write `SessionEnv` methods by
hand in a connector.

---

## Required `SandboxApi` Methods

Implement every method below. If your provider's SDK doesn't have a direct
analogue for a given operation, fall back to running shell commands through
`exec()`. The Daytona connector does this for `mkdir -p`, for example.

### `readFile(path) → Promise<string>`

UTF-8 decode the file at `path` and return its contents.

### `readFileBuffer(path) → Promise<Uint8Array>`

Return the raw bytes at `path` as a `Uint8Array`. If your SDK gives you a
Node `Buffer`, wrap it: `new Uint8Array(buffer)`.

### `writeFile(path, content) → Promise<void>`

Write `content` to `path`. Accept both `string` and `Uint8Array`. Convert
`string` to UTF-8 bytes before sending to providers that only accept buffers.

### `stat(path) → Promise<FileStat>`

Return a `FileStat`. If the provider's SDK doesn't expose mtime or size, use
sensible defaults (`new Date()` and `0`). Symlinks are rare in sandbox
providers — `isSymbolicLink: false` is fine if the SDK doesn't tell you
otherwise.

### `readdir(path) → Promise<string[]>`

Return the names (not full paths) of entries in the directory.

### `exists(path) → Promise<boolean>`

Return `true` if the path exists (file or directory). Most providers throw
on missing paths — wrap in try/catch and return `false`.

### `mkdir(path, options?) → Promise<void>`

Create a directory. If `options.recursive` is set, create parents as needed.
If the provider's SDK only does single-level mkdir, fall back to
`exec('mkdir -p ...')` for the recursive case.

### `rm(path, options?) → Promise<void>`

Delete a file or directory. Honor `options.recursive` and `options.force`.

### `exec(command, options?) → Promise<{ stdout, stderr, exitCode }>`

Run a shell command. Honor `options.cwd`, `options.env`, and
`options.timeout`. If your provider's SDK doesn't expose a native timeout
option, translate `timeout` into an `AbortSignal.timeout(ms)` and pass it
to whatever the SDK accepts — or, as a last resort, race the call against
a `setTimeout` and reject. Connectors **must** make a best-effort attempt
at honoring `timeout`: it's how the LLM bash tool tells the agent "stop
this command after N seconds and let me retry." Returning a 124-shaped
`ShellResult` (`exitCode: 124`, `stderr` describing the timeout) on
deadline expiry matches the convention used by other Flue connectors and
the `timeout(1)` utility.

If your provider's SDK *also* supports an `AbortSignal`, forward
`options.signal` too — this gives SDK-level callers (`agent.shell(cmd,
{ signal })`) true mid-flight cancellation. Connectors whose provider
SDK can't observe a signal should ignore `signal`: Flue's
`createSandboxSessionEnv` wrapper performs pre/post `signal.aborted`
checks for you, so post-completion abort still surfaces correctly without
any work in the connector. Do not attempt to fake mid-flight cancellation
with `Promise.race` against the signal — the underlying remote process
will keep running, which surprises users.

If `stderr` is not separately surfaced, return `''` for it; do the same
for `exitCode` if unavailable, defaulting to `0` only when the call
clearly succeeded.

---

## Sandbox Lifetime

Flue does not manage sandbox lifetime. The user creates the sandbox, the
user decides when (or whether) to delete it. Connectors must not call
`sandbox.delete()`, `sandbox.terminate()`, `sandbox.kill()`, or any
equivalent on the user's behalf.

This means connector factories take no `cleanup` option, and
`createSandboxSessionEnv` takes no cleanup callback. If the connector
itself opens a real socket (e.g. SSH), it can manage that socket
internally — but it must not assume Flue will trigger teardown.

---

## Reference Implementation

See the Daytona connector for a known-good full implementation:

```
https://flueframework.com/cli/connectors/daytona.md
```

Or the raw markdown source:

```
https://raw.githubusercontent.com/withastro/flue/refs/heads/main/connectors/sandbox--daytona.md
```

It's the cleanest example of the patterns described here: shell-fallback for
recursive mkdir, try/catch on `exists()`, and buffer/string conversion in
`writeFile`.

---

## Where the Connector File Lives in the User's Project

The user's project uses one of two layouts:

- **`.flue/` layout** (project already has files at the root, with a `.flue/`
  workspace dir): write the connector to `./.flue/connectors/<name>.ts`.
- **Root layout** (project root *is* the workspace): write the connector to
  `./connectors/<name>.ts`.

If neither feels right for the user's project (e.g. they have a non-standard
layout), ask them where to put it before writing.

---

## Verifying the Generated Connector

Before declaring success:

1. Confirm the file typechecks: `npx tsc --noEmit` (or whatever the user's
   project uses for typechecking).
2. Confirm the import path is valid: the connector imports from
   `@flue/sdk/sandbox` (which is part of `@flue/sdk` already).
3. If the user's `package.json` does not yet depend on the provider's SDK,
   tell them to install it (e.g. `npm install <provider-sdk>`).
4. Tell the user which env vars they need to set (e.g.
   `<PROVIDER>_API_KEY`).
5. Show them the minimal usage snippet to wire the connector into one of
   their agents.
