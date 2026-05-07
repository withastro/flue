---
{
  "category": "sandbox",
  "website": "https://docs.mirage.strukto.ai"
}
---

# Add a Flue Connector: Mirage

You are an AI coding agent installing the Mirage sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized Mirage `Workspace` (created with the user's own
`@struktoai/mirage-node` or `@struktoai/mirage-browser` SDK) into Flue's
`SandboxFactory` interface. The user owns the workspace and its mounts;
this connector just adapts the workspace.

A few things worth knowing about Mirage that shape this connector:

- Mirage is an **in-process unified virtual filesystem**, not a remote VM.
  The user mounts services (RAM, S3, Slack, GitHub, Linear, …) at paths on
  a single tree, and Mirage's in-process shell executor runs Unix commands
  across them. There's no remote sandbox to provision.
- Mirage publishes two runtime packages with the same `Workspace` API:
  `@struktoai/mirage-node` for `--target node`, and
  `@struktoai/mirage-browser` for `--target cloudflare` (Cloudflare Workers
  are a browser-class runtime). The connector itself imports types from
  `@struktoai/mirage-core` (re-exported by both) so the same file works for
  either target. The user picks the right runtime package in their agent
  code based on their build target.
- Some Mirage resources are Node-only (`SSHResource`, `PostgresResource`,
  `MongoDBResource`, `EmailResource`, FUSE). Importing them from
  `@struktoai/mirage-browser` is a build error, so using any of those
  pins the user to `--target node`.
- If you've seen `@struktoai/mirage-agents` in Mirage's docs, **don't
  install it for Flue**. That package adapts Mirage to other agent
  frameworks (OpenAI Agents SDK, Vercel AI SDK, LangChain, Mastra, Pi).
  This Flue connector is the Flue equivalent.
- Mirage's `Workspace.execute()` doesn't yet accept per-call `cwd` or
  `env`, and its `AbortSignal` handling only checks `aborted` once at
  entry. Tracked upstream as
  [strukto-ai/mirage#4](https://github.com/strukto-ai/mirage/issues/4),
  [#5](https://github.com/strukto-ai/mirage/issues/5), and
  [#6](https://github.com/strukto-ai/mirage/issues/6). Until those land,
  `session.shell(cmd, { env })` is a no-op, `{ cwd }` is wrapped via a
  `cd <cwd> && cmd` shell-prefix, and `{ timeout }` won't fire mid-flight.
  The connector code below is structured so that when the upstream fixes
  ship, removing the workarounds is mechanical.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/mirage.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/mirage.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * Mirage connector for Flue.
 *
 * Wraps an already-initialized Mirage `Workspace` (from
 * `@struktoai/mirage-node` or `@struktoai/mirage-browser`) into Flue's
 * SandboxFactory interface. The user constructs the Workspace and mounts
 * resources directly using the Mirage SDK — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Workspace, RAMResource, MountMode } from '@struktoai/mirage-node';
 * import { mirage } from './connectors/mirage';
 *
 * const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE });
 * const agent = await init({ sandbox: mirage(ws), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Workspace as MirageWorkspace } from '@struktoai/mirage-core';

export interface MirageConnectorOptions {
	/**
	 * Default working directory for `exec()` calls when the caller doesn't
	 * pass one. Mirage workspaces are rooted at `/` (mounts hang off this
	 * root), so `/` is the safe default. Pin to a specific writable mount
	 * (e.g. `/data`) if you want the agent to default to working there.
	 */
	cwd?: string;
	/**
	 * Cleanup behavior when the session is destroyed.
	 *
	 * - `false` (default): No cleanup — user manages the workspace lifecycle.
	 * - `true`: Calls `workspace.close()` on session destroy.
	 * - Function: Calls the provided function on session destroy.
	 */
	cleanup?: boolean | (() => Promise<void>);
}

/**
 * Quote a string for safe inclusion in a `bash`-style command line.
 * Mirage's shell executor parses POSIX-ish syntax, so the same single-quote
 * escape used for real bash works here.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a shell-safe `VAR=value VAR2=value2 ...` env prefix.
 * Mirage's executor honors leading assignments the way real shells do, so we
 * can use this to inject per-call env without mutating workspace-level state.
 */
function shellEnvPrefix(env: Record<string, string>): string {
	const entries = Object.entries(env);
	if (entries.length === 0) return '';
	return entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ') + ' ';
}

/**
 * Implements SandboxApi by wrapping a Mirage Workspace.
 *
 * Each Flue session maps onto a dedicated Mirage session (created lazily
 * by id) so that cwd, env, history, and lastExitCode stay isolated when
 * one Workspace is shared across multiple Flue sessions.
 *
 * Filesystem operations route through `workspace.fs.*` (Mirage's direct
 * VFS API) for read/write/readdir/stat/exists/single-level mkdir.
 * Recursive `mkdir -p` and `rm -rf` shell out via `workspace.execute()`
 * because `WorkspaceFS` exposes only single-level `mkdir` and
 * `unlink`/`rmdir`.
 *
 * Known limitations awaiting upstream fixes in Mirage:
 *   - `exec({ env })` is a no-op until per-call env lands upstream
 *     (https://github.com/strukto-ai/mirage/issues/5). The shell-prefix
 *     workaround `FOO=bar cmd` doesn't work — Mirage's parser passes the
 *     assignment as argv rather than honoring it as command-scoped env.
 *   - `exec({ cwd })` is wrapped via `cd <cwd> && cmd` shell-prefix today,
 *     pending per-call cwd support upstream
 *     (https://github.com/strukto-ai/mirage/issues/4).
 *   - `exec({ timeout })` is plumbed via `AbortSignal.timeout()` into
 *     `ExecuteOptions.signal`, but Mirage only checks the signal at entry,
 *     so mid-flight timeouts don't fire today
 *     (https://github.com/strukto-ai/mirage/issues/6). When that lands,
 *     the existing wiring will start working without code change.
 *
 * Once those issues are resolved, the shell-prefix workarounds and the
 * 124-exit-code synthesis below should be removed in favor of passing
 * `cwd`/`env` directly through `ExecuteOptions`.
 */
class MirageSandboxApi implements SandboxApi {
	constructor(
		private workspace: MirageWorkspace,
		private flueSessionId: string,
	) {}

	async readFile(path: string): Promise<string> {
		const bytes = await this.workspace.fs.readFile(path);
		return new TextDecoder('utf-8').decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.workspace.fs.readFile(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const bytes =
			typeof content === 'string' ? new TextEncoder().encode(content) : content;
		await this.workspace.fs.writeFile(path, bytes);
	}

	async stat(path: string): Promise<FileStat> {
		const s = await this.workspace.fs.stat(path);
		// Mirage's FileStat: { name, size: number|null, modified: string|null,
		// type: FileType|null }. FileType.DIRECTORY is the literal 'directory'.
		const isDirectory = s.type === 'directory';
		return {
			isFile: !isDirectory,
			isDirectory,
			isSymbolicLink: false, // Mirage doesn't model symlinks.
			size: s.size ?? 0,
			mtime: s.modified ? new Date(s.modified) : new Date(),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.workspace.fs.readdir(path);
		// Mirage returns full paths; SandboxApi expects entry names.
		return entries.map((p) => p.slice(p.lastIndexOf('/') + 1)).filter((n) => n.length > 0);
	}

	async exists(path: string): Promise<boolean> {
		return this.workspace.fs.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			// `WorkspaceFS.mkdir` is single-level. Mirage's executor implements
			// `mkdir -p` natively, so shell out for the recursive case.
			const result = await this.runShell(`mkdir -p ${shellQuote(path)}`);
			if (result.exitCode !== 0) {
				throw new Error(
					`[flue:mirage] mkdir -p failed for ${path}: ` +
						(result.stderr || result.stdout || `exit ${result.exitCode}`),
				);
			}
			return;
		}
		await this.workspace.fs.mkdir(path);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		// `WorkspaceFS` only exposes `unlink` (file) and `rmdir` (empty dir).
		// For Flue's `recursive` / `force`, shell out to Mirage's `rm`.
		if (options?.recursive || options?.force) {
			const flags: string[] = [];
			if (options.recursive) flags.push('r');
			if (options.force) flags.push('f');
			const result = await this.runShell(`rm -${flags.join('')} ${shellQuote(path)}`);
			if (result.exitCode !== 0) {
				throw new Error(
					`[flue:mirage] rm failed for ${path}: ` +
						(result.stderr || result.stdout || `exit ${result.exitCode}`),
				);
			}
			return;
		}
		// Plain delete: try unlink first, fall back to rmdir for empty dirs.
		try {
			await this.workspace.fs.unlink(path);
		} catch {
			await this.workspace.fs.rmdir(path);
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
		const envPrefix = options?.env ? shellEnvPrefix(options.env) : '';
		const wrapped = options?.cwd
			? `cd ${shellQuote(options.cwd)} && ${envPrefix}${command}`
			: `${envPrefix}${command}`;

		// Flue passes timeout in seconds (per the connector spec); Mirage takes
		// an AbortSignal. Build the signal here so we can detect abort on the
		// way out and synthesize a timeout-shaped result.
		const signal =
			typeof options?.timeout === 'number'
				? AbortSignal.timeout(options.timeout * 1000)
				: undefined;

		try {
			const result = await this.workspace.execute(wrapped, {
				sessionId: this.flueSessionId,
				signal,
			});
			return {
				stdout: result.stdoutText,
				stderr: result.stderrText,
				exitCode: result.exitCode,
			};
		} catch (err) {
			const aborted =
				signal?.aborted &&
				(err === signal.reason ||
					(err instanceof Error &&
						(err.name === 'AbortError' || err.name === 'TimeoutError')));
			if (aborted) {
				return {
					stdout: '',
					stderr: `[flue:mirage] Command timed out after ${options?.timeout} seconds.`,
					exitCode: 124,
				};
			}
			throw err;
		}
	}
}

/**
 * Create a Flue sandbox factory from an initialized Mirage Workspace.
 * The user owns the workspace lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function mirage(
	workspace: MirageWorkspace,
	options?: MirageConnectorOptions,
): SandboxFactory {
	return {
		async createSessionEnv({ id, cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			// Map this Flue session to a dedicated Mirage session so cwd, env,
			// history, and lastExitCode stay isolated across Flue sessions
			// sharing the same Workspace. createSession throws on duplicate
			// ids, so fall back to getSession if the id is already registered
			// (e.g. session resumed after a reload).
			try {
				workspace.createSession(id);
			} catch {
				workspace.getSession(id);
			}

			// Mirage workspaces are mount-rooted at `/`. `/` is a safe no-op
			// prefix for the shell-wrap in exec(); pin via `options.cwd` to
			// default to a specific writable mount (e.g. `/data`).
			const sandboxCwd = cwd ?? options?.cwd ?? '/';
			const api = new MirageSandboxApi(workspace, id);

			const cleanupFn = async (): Promise<void> => {
				// Always release the per-Flue Mirage session (default session
				// is exempt and refuses to close, so guard against that case).
				if (id !== 'default') {
					try {
						await workspace.closeSession(id);
					} catch (err) {
						console.error(`[flue:mirage] Failed to close session ${id}:`, err);
					}
				}
				// Then run user-configured cleanup if any.
				if (options?.cleanup === true) {
					try {
						await workspace.close();
					} catch (err) {
						console.error('[flue:mirage] Failed to close workspace:', err);
					}
				} else if (typeof options?.cleanup === 'function') {
					await options.cleanup();
				}
			};

			return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
		},
	};
}
```

## Required dependencies

This connector imports types from `@struktoai/mirage-core`, plus a runtime
package that provides the `Workspace` class. Pick the runtime package that
matches the user's Flue build target — `@struktoai/mirage-node` for
`--target node`, or `@struktoai/mirage-browser` for `--target cloudflare`.

If you can't tell which target the user is on, check `package.json` scripts
for `flue dev` / `flue build` invocations and look for a `wrangler.jsonc`
(or `.toml` / `.json`) at the project root. If still unclear, ask.

For Node:

```bash
npm install @struktoai/mirage-node
```

For Cloudflare:

```bash
npm install @struktoai/mirage-browser
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

`@struktoai/mirage-core` is a transitive dependency of both runtime packages
and doesn't need to be installed separately.

## Authentication

**Mirage itself has no API key.** It runs in-process — there's no remote
service to authenticate against.

Authentication is per-mounted-resource. Each backend the user mounts
(`S3Resource`, `SlackResource`, `GitHubResource`, `PostgresResource`, …)
has its own credentials, configured when the user constructs the resource
in their own agent code. The connector never touches them.

**Never invent values for any of these credentials** — they must come from
the user. Mirage's docs have a per-resource setup guide for every
supported backend at
`https://docs.mirage.strukto.ai/typescript/setup/<resource>` (e.g.
`…/setup/s3`, `…/setup/slack`).

Use the project's existing conventions (`AGENTS.md`, `.env`, `.dev.vars`,
a secret manager, CI vars) for storing whatever credentials the mounted
resources need. If nothing in the project gives you a clear signal, ask
the user.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { Workspace, RAMResource, MountMode } from '@struktoai/mirage-node';
import { mirage } from '../connectors/mirage'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  const ws = new Workspace(
    { '/data': new RAMResource() },
    { mode: MountMode.WRITE },
  );

  const agent = await init({
    sandbox: mirage(ws, { cwd: '/data', cleanup: true }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('echo "hello mirage" > /data/hello.txt && cat /data/hello.txt');
}
```

On `--target cloudflare`, swap the Mirage import to
`@struktoai/mirage-browser` — everything else stays the same. Once the user
mounts a real resource (S3, Slack, GitHub, …) they'll set its credentials
per Mirage's per-resource setup docs.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@struktoai/mirage-node` or
   `@struktoai/mirage-browser` (whichever matches their target), make sure
   any credentials for resources they mount are available at runtime (per
   the Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
