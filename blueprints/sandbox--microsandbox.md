---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://microsandbox.dev",
  "aliases": ["msb"]
}
---

# Add a Flue Sandbox Adapter: Microsandbox

You are an AI coding agent installing the Microsandbox sandbox adapter for
a Flue project. Follow these instructions exactly. Confirm with the user
only when something is genuinely ambiguous (e.g. an unusual project
layout).

## What this adapter does

Wraps an already-initialized Microsandbox `Sandbox` (created with the
user's own `microsandbox` SDK) into Flue's `SandboxFactory` interface. The
user owns the sandbox lifecycle; this adapter just adapts it.

Things to know before installing:

- Microsandbox boots real microVMs (hardware isolation via a guest kernel,
  not container namespaces) from any OCI image. The `microsandbox` npm
  package embeds the runtime through a native addon and boots sandboxes
  directly on the host — there is no separate server process to run or
  connect to for local use.
- The host needs hardware virtualization: Linux with KVM, macOS on Apple
  Silicon, or Windows 10+ with Windows Hypervisor Platform enabled.
  `Sandbox.builder(...).create()` fails without it.
- Every sandbox has a required `name` (used to resume, look up, or list it
  later with `Sandbox.get()` / `Sandbox.start()`), not an opaque id the SDK
  generates for you. Creating with a name that already exists throws
  `SandboxAlreadyExistsError` unless the builder's `.replace()` was set.
- `sandbox.fs()` returns a filesystem handle scoped to that sandbox;
  `sandbox.exec()` / `.execWith()` run a single argv command with no
  shell, while `.shell()` runs through the guest's configured shell but
  takes no `cwd`/`env`/`timeout` options. This adapter runs everything
  through `sh -c '<command>'` via `execStreamWith` so cwd, env, and
  timeout all forward correctly.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/microsandbox.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/microsandbox@1
/**
 * Microsandbox adapter for Flue.
 *
 * Wraps an already-initialized Microsandbox `Sandbox` into Flue's
 * SandboxFactory interface. The user creates and boots the sandbox using
 * the microsandbox SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from 'microsandbox';
 * import { microsandbox } from './sandboxes/microsandbox';
 *
 * const sandbox = await Sandbox.builder(`agent-${Date.now()}`).image('python').create();
 * const agent = defineAgent(() => ({ sandbox: microsandbox(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   return await (await harness.session()).prompt('Inspect the workspace.');
 * }});
 * ```
 */
import { createSandboxSessionEnv, SandboxOperationUnsupportedError } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import { ExecTimeoutError } from 'microsandbox';
import type { Sandbox as MicrosandboxSandbox, SandboxFsOps } from 'microsandbox';

export interface MicrosandboxAdapterOptions {
	/**
	 * Working directory for exec() calls and the session workspace root.
	 * Microsandbox boots arbitrary OCI images with no fixed home directory,
	 * so there is no universal default. Defaults to `/`.
	 */
	cwd?: string;
}

/**
 * Quote a string for safe inclusion in a `sh -c` command line.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements SandboxApi by wrapping the microsandbox TypeScript SDK.
 *
 * Filesystem operations map directly onto `sandbox.fs()` — `write()` and
 * `read()` already accept/return `Uint8Array | string` and raw bytes, so
 * no buffer conversion is needed, and `exists()` returns a plain boolean
 * with no error to catch. `mkdir()` and `remove()`/`removeDir()` are
 * single-level (no recursive flag), so recursive mkdir falls back to a
 * shell command and `rm()` rejects `recursive`/`force` before mutating,
 * trying file removal before directory removal like other single-level
 * providers.
 *
 * `exec()` always runs through `sh -c '<command>'` via `execStreamWith` so
 * `cwd`, `env`, and `timeoutMs` (a direct millisecond match — no rounding
 * needed) forward through the native `ExecOptionsBuilder`, and `signal`
 * gets true mid-flight cancellation via the returned handle's `kill()`. A
 * native timeout throws `ExecTimeoutError`, which this adapter converts to
 * an exit-code-124 result, matching the convention used by other adapters.
 */
class MicrosandboxSandboxApi implements SandboxApi {
	private readonly fs: SandboxFsOps;

	constructor(private sandbox: MicrosandboxSandbox) {
		this.fs = sandbox.fs();
	}

	async readFile(path: string): Promise<string> {
		return this.fs.readToString(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.fs.read(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.fs.write(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const meta = await this.fs.stat(path);
		return {
			isFile: meta.kind === 'file',
			isDirectory: meta.kind === 'directory',
			isSymbolicLink: meta.kind === 'symlink',
			size: meta.size,
			...(meta.modified ? { mtime: meta.modified } : {}),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.fs.list(path);
		return entries
			.map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1))
			.filter((name) => name.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		return this.fs.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			const result = await this.sandbox.exec('sh', ['-c', `mkdir -p ${shellQuote(path)}`]);
			if (!result.success) {
				throw new Error(
					`[flue:microsandbox] mkdir -p failed for ${path}: ${result.stderr() || result.stdout()}`,
				);
			}
			return;
		}
		await this.fs.mkdir(path);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const unsupported = [
			options?.recursive ? 'recursive' : undefined,
			options?.force ? 'force' : undefined,
		].filter((option): option is string => option !== undefined);
		if (unsupported.length > 0) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Microsandbox',
				options: unsupported,
			});
		}
		try {
			await this.fs.remove(path);
		} catch {
			await this.fs.removeDir(path);
		}
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const handle = await this.sandbox.execStreamWith('sh', (builder) => {
			let built = builder.args(['-c', command]);
			if (options?.cwd) built = built.cwd(options.cwd);
			if (options?.env) {
				for (const [key, value] of Object.entries(options.env)) built = built.env(key, value);
			}
			if (typeof options?.timeoutMs === 'number') built = built.timeout(options.timeoutMs);
			return built;
		});

		let onAbort: (() => void) | undefined;
		if (options?.signal) {
			if (options.signal.aborted) {
				void handle.kill();
			} else {
				onAbort = () => void handle.kill();
				options.signal.addEventListener('abort', onAbort, { once: true });
			}
		}

		try {
			const result = await handle.collect();
			return { stdout: result.stdout(), stderr: result.stderr(), exitCode: result.code };
		} catch (err) {
			if (err instanceof ExecTimeoutError) {
				return {
					stdout: '',
					stderr: `[flue:microsandbox] Command timed out after ${options?.timeoutMs} milliseconds.`,
					exitCode: 124,
				};
			}
			throw err;
		} finally {
			if (onAbort) options?.signal?.removeEventListener('abort', onAbort);
		}
	}
}

/**
 * Create a Flue sandbox factory from an initialized Microsandbox Sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function microsandbox(
	sandbox: MicrosandboxSandbox,
	options?: MicrosandboxAdapterOptions,
): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const sandboxCwd = options?.cwd ?? '/';
			const api = new MicrosandboxSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `microsandbox`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install microsandbox@^0.6.2
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

This is a native-addon package: installing it also pulls in a matching
`@superradcompany/microsandbox-<platform>` optional dependency (macOS
arm64, Linux x64/arm64, or Windows x64/arm64) that carries the native
binding plus the bundled `msb` and `libkrunfw` runtime binaries. If the
project installs with optional dependencies disabled, that platform
package won't be present — see Authentication below.

## Authentication

This adapter needs no API key for local sandboxes. The `microsandbox`
Node package embeds the runtime directly and boots sandboxes on the host
machine; there is no remote service to authenticate against.

The host does need hardware virtualization: Linux with KVM, macOS on
Apple Silicon, or Windows 10+ with Windows Hypervisor Platform enabled.
`Sandbox.builder(...).create()` fails without it — this is a hardware/OS
prerequisite, not something `npm install` can provide.

If the matching `@superradcompany/microsandbox-<platform>` package is
missing (e.g. optional dependencies were disabled), reinstall with
optional dependencies enabled, add that package explicitly, or set
`MSB_PATH` to a working `msb` binary. **Never invent a value for
`MSB_PATH`** — only reach for it if the user's environment already has a
binary to point at.

If the user is pointing this adapter at a self-hosted or cloud-hosted
Microsandbox deployment they manage separately (rather than the embedded
local runtime), whatever credentials that deployment needs are outside
this adapter's scope. Use the project's conventions (`AGENTS.md`, an
existing `.env` / `.dev.vars`, a secret manager, CI vars, etc.) to decide
where they belong, and ask the user only if nothing in the project gives
a clear signal.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { Sandbox } from 'microsandbox';
import { microsandbox } from '../sandboxes/microsandbox'; // adjust path to match the user's layout

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(async () => {
  const sandbox = await Sandbox.builder(`agent-${Date.now()}`)
    .image('python')
    .replace()
    .create();
  return {
    sandbox: microsandbox(sandbox),
    model: 'anthropic/claude-sonnet-4-6',
  };
});

export default defineWorkflow({
  agent,
  run: async ({ harness }) => {
    const session = await harness.session();
    return await session.shell('uname -a');
  },
});
```

`.replace()` stops and removes any sandbox already registered under the
same name before creating the new one, which keeps retried agent runs
from throwing `SandboxAlreadyExistsError` on a name collision. Flue does
not manage sandbox lifetime — if the user wants sandboxes to expire on
their own, configure `.maxDuration(secs)` or `.idleTimeout(secs)` on the
builder rather than relying on Flue to clean them up.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `microsandbox` (if you didn't),
   confirm their machine has hardware virtualization available (per the
   Authentication section above), and run `flue dev` (or
   `flue run <workflow>`) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-07-02

Initial version.
