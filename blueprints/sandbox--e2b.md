---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://e2b.dev"
}
---

# Add a Flue Sandbox Adapter: E2B

You are an AI coding agent installing the E2B sandbox adapter for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized E2B sandbox (created with the user's own `e2b`
SDK client) into Flue's `SandboxFactory` interface. The user owns the E2B
sandbox lifecycle; this adapter just adapts the sandbox.

E2B ships Firecracker microVMs, so each sandbox is a full Linux environment
with persistent disk during its lifetime. Cold start is fast (sub-second in
the same region) and sandboxes can run for up to 24 hours.

This adapter targets the v2 `e2b` package (the general-purpose sandbox).
If the user is specifically after a Jupyter-style code interpreter, they can
swap in `@e2b/code-interpreter` — its `Sandbox` class has the same
`commands` and `files` modules used here.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/e2b.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/e2b@1
/**
 * E2B adapter for Flue.
 *
 * Wraps an already-initialized E2B sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the E2B
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from 'e2b';
 * import { e2b } from './sandboxes/e2b';
 *
 * const sandbox = await Sandbox.create();
 * const agent = defineAgent(() => ({ sandbox: e2b(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   return await (await harness.session()).prompt('Inspect the workspace.');
 * }});
 * ```
 */
import { createSandboxSessionEnv, SandboxOperationUnsupportedError } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as E2BSandbox } from 'e2b';

/**
 * Implements SandboxApi by wrapping the E2B v2 TypeScript SDK.
 *
 * E2B's `files` module has direct analogues for most filesystem operations
 * (`read`, `write`, `makeDir`, `remove`, `list`, `exists`, `getInfo`) so we
 * use those rather than shelling out. `makeDir` is always recursive on E2B,
 * so the `recursive: false` case maps to the same call. `remove` has no
 * recursive/force flags, so the adapter explicitly rejects either option
 * before calling the provider.
 *
 * `commands.run()` returns `{ stdout, stderr, exitCode }` directly. Both E2B
 * and Flue express command timeouts in milliseconds, so the adapter forwards
 * them unchanged.
 */
class E2BSandboxApi implements SandboxApi {
	constructor(private sandbox: E2BSandbox) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.files.read(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.sandbox.files.read(path, { format: 'bytes' });
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		// E2B accepts string | ArrayBuffer | Blob | ReadableStream. A
		// Uint8Array's underlying ArrayBuffer is the right shape, but slice
		// to its actual byteLength in case the buffer is a larger pool.
		if (typeof content === 'string') {
			await this.sandbox.files.write(path, content);
		} else {
			const ab = content.buffer.slice(
				content.byteOffset,
				content.byteOffset + content.byteLength,
			) as ArrayBuffer;
			await this.sandbox.files.write(path, ab);
		}
	}

	async stat(path: string): Promise<FileStat> {
		const info = await this.sandbox.files.getInfo(path);
		const isDirectory = info.type === 'dir';
		return {
			isFile: info.type === 'file',
			isDirectory,
			isSymbolicLink: typeof info.symlinkTarget === 'string' && info.symlinkTarget.length > 0,
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.sandbox.files.list(path);
		return entries.map((e) => e.name);
	}

	async exists(path: string): Promise<boolean> {
		return this.sandbox.files.exists(path);
	}

	async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
		// E2B's makeDir creates parents along the way unconditionally, so
		// the `recursive` option doesn't change behavior here.
		await this.sandbox.files.makeDir(path);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const unsupported = [
			options?.recursive ? 'recursive' : undefined,
			options?.force ? 'force' : undefined,
		].filter((option): option is string => option !== undefined);
		if (unsupported.length > 0) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'E2B',
				options: unsupported,
			});
		}
		await this.sandbox.files.remove(path);
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
		const result = await this.sandbox.commands.run(command, {
			cwd: options?.cwd,
			envs: options?.env,
			timeoutMs: options?.timeoutMs,
		});
		return {
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			exitCode: result.exitCode ?? 0,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized E2B sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function e2b(sandbox: E2BSandbox): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			// The E2B base template's default user is `user` with home
			// directory /home/user.
			const sandboxCwd = '/home/user';
			const api = new E2BSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `e2b`, so the user's project needs to depend on
it directly. If their `package.json` does not already list it, add it:

```bash
npm install e2b@^2.30.0
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

If the user is specifically building a Jupyter-style code interpreter
agent, they may already have `@e2b/code-interpreter` installed instead.
That package re-exports the same `Sandbox` class with extra `runCode`
methods — this adapter will work with it too. Adjust the import to
`from '@e2b/code-interpreter'` if so.

## Authentication

This adapter needs `E2B_API_KEY` at runtime. **Never invent a value for
it** — it must come from the user.

API keys are issued from the E2B dashboard at `https://e2b.dev/dashboard`.

Use your judgment for where the secret should live. The project's
conventions, an `AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a
secret manager, CI vars, etc.) will usually tell you the right answer. If
nothing in the project gives you a clear signal, ask the user instead of
guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { Sandbox } from 'e2b';
import { e2b } from '../sandboxes/e2b'; // adjust path to match the user's layout

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(async () => {
  // E2B reads E2B_API_KEY from the environment automatically.
  const sandbox = await Sandbox.create();
  return {
    sandbox: e2b(sandbox),
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

Tip: if the user runs many short-lived agents off the same prepared
environment, point them at E2B's custom templates
(`Sandbox.create('<template-name-or-id>')`) so they're not reinstalling
tooling on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `e2b` (if you didn't), make sure
   `E2B_API_KEY` is available at runtime (per the Authentication section
   above), and run `flue dev` (or `flue run <workflow>`) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
