---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://superserve.ai"
}
---

# Add a Flue Sandbox Adapter: Superserve

You are an AI coding agent installing the Superserve sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized Superserve sandbox (created with the user's own
`@superserve/sdk` `Sandbox.create()` / `Sandbox.connect()`) into Flue's
`SandboxFactory` interface. The user owns the sandbox lifecycle; this adapter
just adapts the sandbox.

Each Superserve sandbox is a Firecracker microVM with its own filesystem that
persists for the life of the session. Between turns a sandbox can be paused:
Superserve snapshots the full VM state — memory, processes, and filesystem —
at zero compute cost and resumes it on the next exec in under 100ms. A
long-running agent that spends most of a session waiting therefore only pays
for compute while it is actively working.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/superserve.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/superserve@1
/**
 * Superserve adapter for Flue.
 *
 * Wraps an already-initialized Superserve sandbox (a `Sandbox` from
 * `@superserve/sdk`) into Flue's SandboxFactory interface. The user creates
 * and configures the sandbox using the Superserve SDK directly — Flue just
 * adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from '@superserve/sdk';
 * import { superserve } from './sandboxes/superserve';
 *
 * const sandbox = await Sandbox.create({ name: 'my-agent' });
 * const agent = createAgent(() => ({ sandbox: superserve(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * const harness = await init(agent);
 * const session = await harness.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as SuperserveSandbox } from '@superserve/sdk';

/**
 * Quote a string for safe inclusion in a shell command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements SandboxApi by wrapping the Superserve TypeScript SDK.
 *
 * Superserve's `commands.run()` returns `{ stdout, stderr, exitCode }`
 * directly, so `exec()` is a thin pass-through. The platform wraps the
 * command in a shell on its end — passing a single string is correct;
 * don't pre-wrap in `bash -lc`.
 *
 * Filesystem operations split across two surfaces:
 *
 *   - `readFile` / `readFileBuffer` / `writeFile` use Superserve's
 *     data-plane file API (`sandbox.files.*`) directly. Note: paths must be
 *     absolute (start with `/`) and must not contain `..` segments — the SDK
 *     validates this client-side and throws on bad input.
 *   - `stat`, `readdir`, `exists`, `mkdir`, `rm` have no native SDK analogue,
 *     so they shell out via `exec()`. The default Superserve base image is
 *     Ubuntu 24.04 with GNU coreutils, so the standard `stat -c`, `ls -A1`,
 *     `mkdir -p`, `rm -rf`, `test -e` recipes all work.
 *
 * Both Superserve and Flue express command timeouts in milliseconds, so the
 * adapter forwards `timeoutMs` unchanged. Superserve's SDK also accepts an
 * `AbortSignal`, so the caller's `signal` is forwarded for mid-flight
 * cancellation.
 */
class SuperserveSandboxApi implements SandboxApi {
	constructor(private sandbox: SuperserveSandbox) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.files.readText(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.sandbox.files.read(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		// `sandbox.files.write` accepts `string | Uint8Array | ArrayBuffer | Blob`
		// and copies a Uint8Array into a plain ArrayBuffer internally, so we can
		// pass content straight through.
		await this.sandbox.files.write(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		// `stat -c '%F|%s|%Y'` is GNU stat (default on the Superserve base
		// image, Ubuntu 24.04). Format: <type>|<size>|<mtime-epoch>.
		const result = await this.runShell(
			`stat -c '%F|%s|%Y' ${shellQuote(path)} 2>/dev/null`,
		);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			throw new Error(
				`[flue:superserve] stat failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
		}
		const fields = result.stdout.trim().split('|');
		const [type, sizeStr, mtimeStr] = fields;
		const size = Number(sizeStr);
		const mtimeSecs = Number(mtimeStr);
		const mtime = new Date(mtimeSecs * 1000);
		if (
			fields.length !== 3 ||
			!sizeStr ||
			!mtimeStr ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			!Number.isSafeInteger(mtimeSecs) ||
			!Number.isFinite(mtime.getTime())
		) {
			throw new Error(`[flue:superserve] malformed stat output for ${path}`);
		}
		return {
			isFile: type === 'regular file' || type === 'regular empty file',
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size,
			mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		// `ls -A1` excludes . and .. but lists dotfiles, one per line.
		const result = await this.runShell(`ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] readdir failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
		}
		return result.stdout.split('\n').filter((line) => line.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		const result = await this.runShell(`test -e ${shellQuote(path)}`);
		return result.exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const cmd = options?.recursive
			? `mkdir -p ${shellQuote(path)}`
			: `mkdir ${shellQuote(path)}`;
		const result = await this.runShell(cmd);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] mkdir failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const flagArg = flags ? ` -${flags}` : '';
		const result = await this.runShell(`rm${flagArg} ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] rm failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
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
		return this.runShell(command, options);
	}

	private async runShell(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const result = await this.sandbox.commands.run(command, {
				cwd: options?.cwd,
				env: options?.env,
				// Superserve and Flue both express command timeouts in milliseconds.
				timeoutMs: options?.timeoutMs,
				signal: options?.signal,
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
		} catch (err) {
			// If the caller's signal fired, rethrow so the host abort propagates.
			if (options?.signal?.aborted) throw err;
			// A hard timeout surfaces as the SDK's `TimeoutError`; map it to the
			// conventional 124 ShellResult so the bash tool can recover rather
			// than seeing an exception.
			if (err instanceof Error && err.name === 'TimeoutError') {
				return {
					stdout: '',
					stderr: `[flue:superserve] command timed out after ${options?.timeoutMs} milliseconds.`,
					exitCode: 124,
				};
			}
			throw err;
		}
	}
}

/**
 * Create a Flue sandbox factory from an initialized Superserve sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function superserve(sandbox: SuperserveSandbox): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			// The Superserve base template's default user is `user` with home
			// directory /home/user.
			const sandboxCwd = '/home/user';
			const api = new SuperserveSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `@superserve/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it, add
it:

```bash
npm install @superserve/sdk@^0.7.6
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This adapter needs `SUPERSERVE_API_KEY` at runtime (a long-lived API key that
starts with `ss_live_`). **Never invent a value for it** — it must come from
the user.

API keys are issued from the Superserve console at
`https://console.superserve.ai`.

Use your judgment for where the secret should live. The project's
conventions, an `AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a
secret manager, CI vars, etc.) will usually tell you the right answer. If
nothing in the project gives you a clear signal, ask the user instead of
guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the user is
already working on an agent that this adapter is meant to plug into, you can
finish that work by wiring the adapter into it. Otherwise, share this snippet
so they can wire it up themselves.

```ts
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import { Sandbox } from '@superserve/sdk';
import { superserve } from '../sandboxes/superserve'; // adjust path to match the user's layout

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run ({ init }: FlueContext) {
  // The Superserve SDK reads SUPERSERVE_API_KEY from the environment
  // automatically; pass `apiKey` explicitly only if you keep it elsewhere.
  const sandbox = await Sandbox.create({ name: 'agent' });

  const agent = createAgent(() => ({
    sandbox: superserve(sandbox),
    model: 'anthropic/claude-sonnet-4-6',
  }));
  const harness = await init(agent);
  const session = await harness.session();

  return await session.shell('uname -a');
}
```

Tip: each sandbox boots from a template — a reusable base image with
dependencies baked in. The default `superserve/base` is a minimal Ubuntu
24.04 image (`git`, `curl`, and `ca-certificates`, no language runtimes), so
if the agent needs Node.js or Python, point it at a curated template such as
`superserve/node-22` or `superserve/python-3.11`
(`Sandbox.create({ name, fromTemplate: 'superserve/node-22' })`), or have the
user build a [custom template](https://docs.superserve.ai/templates/overview)
with their tooling baked in so they're not installing it on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@superserve/sdk` (if you didn't),
   make sure `SUPERSERVE_API_KEY` is available at runtime (per the
   Authentication section above), and run `flue dev` (or `flue run <workflow>`)
   to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-18

Initial version.
