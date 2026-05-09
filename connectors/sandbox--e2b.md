---
{
  "category": "sandbox",
  "website": "https://e2b.dev"
}
---

# Add a Flue Connector: E2B

You are an AI coding agent installing the E2B sandbox connector for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized E2B sandbox (created with the user's own `e2b`
SDK client) into Flue's `SandboxFactory` interface. The user owns the E2B
sandbox lifecycle; this connector just adapts the sandbox.

E2B ships Firecracker microVMs, so each sandbox is a full Linux environment
with persistent disk during its lifetime. Cold start is fast (sub-second in
the same region) and sandboxes can run for up to 24 hours.

This connector targets the v2 `e2b` package (the general-purpose sandbox).
If the user is specifically after a Jupyter-style code interpreter, they can
swap in `@e2b/code-interpreter` — its `Sandbox` class has the same
`commands` and `files` modules used here.

## Where to write the file

Pick the location based on the user's source layout (analogous to Next.js's
`src/` folder):

- **If `<workspace>/.flue/` exists**, write to `./.flue/connectors/e2b.ts`.
- **Otherwise**, write to `./connectors/e2b.ts` at the workspace root.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * E2B connector for Flue.
 *
 * Wraps an already-initialized E2B sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the E2B
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from 'e2b';
 * import { e2b } from './connectors/e2b';
 *
 * const sandbox = await Sandbox.create();
 * const agent = await init({ sandbox: e2b(sandbox), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as E2BSandbox } from 'e2b';

/**
 * Implements SandboxApi by wrapping the E2B v2 TypeScript SDK.
 *
 * E2B's `files` module has direct analogues for most filesystem operations
 * (`read`, `write`, `makeDir`, `remove`, `list`, `exists`, `getInfo`) so we
 * use those rather than shelling out. `makeDir` is always recursive on E2B,
 * so the `recursive: false` case maps to the same call. `remove` has no
 * recursive/force flags — it just removes the path — so those options are
 * accepted for interface compatibility but ignored.
 *
 * `commands.run()` returns `{ stdout, stderr, exitCode }` directly. E2B
 * takes timeouts in milliseconds; Flue passes them in seconds (per the
 * connector spec) so we multiply.
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
			size: info.size ?? 0,
			mtime: info.modifiedTime ?? new Date(),
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

	async rm(path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		// E2B's remove() takes no flags — it removes whatever is at the
		// path. The `force` option is implicitly satisfied (no error on
		// missing paths is not guaranteed, but most callers wrap in a
		// safety net anyway).
		await this.sandbox.files.remove(path);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const result = await this.sandbox.commands.run(command, {
			cwd: options?.cwd,
			envs: options?.env,
			// Flue passes timeout in seconds; E2B expects milliseconds.
			timeoutMs: typeof options?.timeout === 'number' ? options.timeout * 1000 : undefined,
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
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			// The E2B base template's default user is `user` with home
			// directory /home/user. Sessions inherit this unless the caller
			// overrides cwd.
			const sandboxCwd = cwd ?? '/home/user';
			const api = new E2BSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This connector imports from `e2b`, so the user's project needs to depend on
it directly. If their `package.json` does not already list it, add it:

```bash
npm install e2b
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

If the user is specifically building a Jupyter-style code interpreter
agent, they may already have `@e2b/code-interpreter` installed instead.
That package re-exports the same `Sandbox` class with extra `runCode`
methods — this connector will work with it too. Adjust the import to
`from '@e2b/code-interpreter'` if so.

## Authentication

This connector needs `E2B_API_KEY` at runtime. **Never invent a value for
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

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { Sandbox } from 'e2b';
import { e2b } from '../connectors/e2b'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  // E2B reads E2B_API_KEY from the environment automatically.
  const sandbox = await Sandbox.create();

  const agent = await init({
    sandbox: e2b(sandbox),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

Tip: if the user runs many short-lived agents off the same prepared
environment, point them at E2B's custom templates
(`Sandbox.create('<template-name-or-id>')`) so they're not reinstalling
tooling on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `e2b` (if you didn't), make sure
   `E2B_API_KEY` is available at runtime (per the Authentication section
   above), and run `flue dev` (or `flue run <agent>`) to try it.
