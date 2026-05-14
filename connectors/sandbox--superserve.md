---
{
  "category": "sandbox",
  "website": "https://superserve.ai"
}
---

# Add a Flue Connector: Superserve

You are an AI coding agent installing the Superserve sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized Superserve sandbox (created with the user's own
`@superserve/sdk` `Sandbox.create()` / `Sandbox.connect()`) into Flue's
`SandboxFactory` interface. The user owns the sandbox lifecycle; this
connector just adapts the sandbox.

Superserve runs each sandbox as a Firecracker microVM. Cold start is
sub-second, and paused sandboxes auto-resume on the next exec, which makes
it a good fit for long-running agent sessions that need to persist state
across gaps in traffic.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/superserve.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/superserve.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * Superserve connector for Flue.
 *
 * Wraps an already-initialized Superserve sandbox (a `Sandbox` from
 * `@superserve/sdk`) into Flue's SandboxFactory interface. The user creates
 * and configures the sandbox using the Superserve SDK directly — Flue just
 * adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from '@superserve/sdk';
 * import { superserve } from './connectors/superserve';
 *
 * const sandbox = await Sandbox.create({ name: 'my-agent' });
 * const agent = await init({ sandbox: superserve(sandbox), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as SuperserveSandbox } from '@superserve/sdk';

export interface SuperserveConnectorOptions {
	/**
	 * Cleanup behavior when the session is destroyed.
	 *
	 * - `false` (default): No cleanup — user manages the sandbox lifecycle.
	 * - `true`: Calls `sandbox.kill()` on session destroy.
	 * - Function: Calls the provided function on session destroy.
	 */
	cleanup?: boolean | (() => Promise<void>);
}

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
 *     data-plane file API (`sandbox.files.*`) directly. Note: paths must
 *     be absolute (start with `/`) and must not contain `..` segments —
 *     the SDK validates this client-side and throws `ValidationError` on
 *     bad input.
 *   - `stat`, `readdir`, `exists`, `mkdir`, `rm` have no native SDK
 *     analogue, so they shell out via `exec()`. The default Superserve
 *     base image ships GNU coreutils, so the standard `stat -c`, `ls -A1`,
 *     `mkdir -p`, `rm -rf`, `test -e` recipes all work.
 *
 * Superserve takes timeouts in milliseconds; Flue passes them in seconds
 * (per the connector spec) so we multiply.
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
		// and copies Uint8Array into a plain ArrayBuffer internally, so we can
		// pass content straight through.
		await this.sandbox.files.write(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		// `stat -c '%F|%s|%Y'` is GNU stat (default on the Superserve base
		// image, Ubuntu 24.04). Format: <type>|<size>|<mtime-epoch>.
		const result = await this.runShell(
			`stat -c '%F|%s|%Y' ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] stat failed for ${path}: ${result.stderr || result.stdout}`,
			);
		}
		const [type = '', sizeStr = '0', mtimeStr = '0'] = result.stdout.trim().split('|');
		const size = Number.parseInt(sizeStr, 10);
		const mtimeSecs = Number.parseInt(mtimeStr, 10);
		return {
			isFile: type === 'regular file' || type === 'regular empty file',
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size: Number.isFinite(size) ? size : 0,
			mtime: new Date((Number.isFinite(mtimeSecs) ? mtimeSecs : 0) * 1000),
		};
	}

	async readdir(path: string): Promise<string[]> {
		// `ls -A1` excludes . and .. but lists dotfiles, one per line.
		const result = await this.runShell(`ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] readdir failed for ${path}: ${result.stderr || result.stdout}`,
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
				`[flue:superserve] mkdir failed for ${path}: ${result.stderr || result.stdout}`,
			);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		let flags = '';
		if (options?.recursive) flags += 'r';
		if (options?.force) flags += 'f';
		const flagPart = flags.length > 0 ? `-${flags} ` : '';
		const result = await this.runShell(`rm ${flagPart}${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:superserve] rm failed for ${path}: ${result.stderr || result.stdout}`,
			);
		}
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return this.runShell(command, options);
	}

	private async runShell(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const result = await this.sandbox.commands.run(command, {
				cwd: options?.cwd,
				env: options?.env,
				// Flue passes timeout in seconds; Superserve expects milliseconds.
				timeoutMs: typeof options?.timeout === 'number' ? options.timeout * 1000 : undefined,
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
			};
		} catch (err) {
			const isTimeout =
				err !== null &&
				typeof err === 'object' &&
				(err as { name?: string }).name === 'TimeoutError';
			if (isTimeout) {
				return {
					stdout: '',
					stderr: `[flue:superserve] command timed out after ${options?.timeout}s`,
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
export function superserve(
	sandbox: SuperserveSandbox,
	options?: SuperserveConnectorOptions,
): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? '/home/user';
			const api = new SuperserveSandboxApi(sandbox);

			let cleanupFn: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanupFn = async () => {
					try {
						await sandbox.kill();
					} catch (err) {
						console.error('[flue:superserve] Failed to kill sandbox:', err);
					}
				};
			} else if (typeof options?.cleanup === 'function') {
				cleanupFn = options.cleanup;
			}

			return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
		},
	};
}
```

## Required dependencies

This connector imports from `@superserve/sdk`, so the user's project needs
to depend on it directly. If their `package.json` does not already list
it, add it:

```bash
npm install @superserve/sdk
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This connector needs `SUPERSERVE_API_KEY` at runtime (a long-lived API key
that starts with `ss_live_`). **Never invent a value for it** — it must
come from the user.

API keys are issued from the Superserve console at
`https://console.superserve.ai`.

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
import { Sandbox } from '@superserve/sdk';
import { superserve } from '../connectors/superserve'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  // The Superserve SDK reads SUPERSERVE_API_KEY from the environment
  // automatically; pass `apiKey` explicitly only if you keep it elsewhere.
  const sandbox = await Sandbox.create({ name: `agent-${Date.now()}` });

  const agent = await init({
    sandbox: superserve(sandbox, { cleanup: true }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

Tip: each sandbox boots from a template — a reusable base image with
dependencies baked in. The default `superserve/base` is Ubuntu 24.04 with
Python 3.12 and Node.js 22; if the user runs many short-lived agents off
the same prepared environment, point them at a curated template
(`Sandbox.create({ name, fromTemplate: 'superserve/node-22' })`) or have
them build a [custom template](https://docs.superserve.ai/templates) so
they're not reinstalling tooling on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@superserve/sdk` (if you didn't),
   make sure `SUPERSERVE_API_KEY` is available at runtime (per the
   Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
