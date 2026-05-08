---
{
  "category": "sandbox",
  "website": "https://islo.dev"
}
---

# Add a Flue Connector: islo

You are an AI coding agent installing the [islo](https://islo.dev) sandbox
connector for a Flue project. Follow these instructions exactly. Confirm with
the user only when something is genuinely ambiguous (e.g. an unusual project
layout).

## What this connector does

Wraps an islo sandbox (referenced by name) into Flue's `SandboxFactory`. The
user creates the sandbox once with `islo use <name>`; the connector adapts
the named sandbox so Flue agents can run shell commands and read/write files
inside it.

islo is CLI-first — there is no npm SDK. The connector shells out to the
local `islo` binary via `node:child_process`. **This means it requires a
Node.js runtime with shell access wherever the agent runs**, including the
user's deploy target. It works on Node servers, containers, and CI runners
(GitHub Actions, GitLab CI) where the islo CLI can be installed on `PATH`.
It does **not** work in JS-only edge runtimes such as Cloudflare Workers or
Vercel Edge — there's no `child_process` and no way to install a native
binary. Tell the user this up front if their target is an edge runtime;
they'll need a different sandbox provider.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/islo.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/islo.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract, and the shell quoting in particular is load-bearing.

```ts
/**
 * islo connector for Flue. Adapts a named islo sandbox to Flue's SandboxApi
 * by shelling out to the islo CLI. The user owns the sandbox lifecycle.
 *
 * @example
 * ```ts
 * import { islo } from './connectors/islo';
 *
 * const agent = await init({
 *   sandbox: islo('my-sandbox'),
 *   model: 'anthropic/claude-sonnet-4-6',
 * });
 * ```
 */
import { spawn } from 'node:child_process';
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';

export interface IsloConnectorOptions {
	/** Default cwd inside the sandbox. Defaults to `/workspace`. */
	cwd?: string;
	/** Path to the islo binary. Defaults to `"islo"` (resolved via PATH). */
	cliPath?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Implements SandboxApi via the islo CLI. Every operation runs as
 * `islo --output json use <name> -- bash -lc <cmd>`. With `--output json`,
 * the CLI writes the remote command's stdout straight to local stdout,
 * remote stderr to local stderr, and propagates the exit code — so we
 * don't need any wrapper protocol. The CLI does append a trailing
 * `\nExit code: N\n` line to stderr on non-zero exits; we strip it.
 *
 * File ops route through `exec()`. Binary content goes via base64 inline
 * (single-quote-safe alphabet) because the CLI decodes stdout as UTF-8.
 */
class IsloSandboxApi implements SandboxApi {
	constructor(
		private name: string,
		private cliPath: string,
	) {}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const cd = options?.cwd ? `cd ${q(options.cwd)} && ` : '';
		const envPrefix = options?.env
			? Object.entries(options.env)
					.map(([k, v]) => `${k}=${q(v)}`)
					.join(' ') + ' '
			: '';
		// Enforce timeout via GNU coreutils `timeout(1)` inside the sandbox.
		// islo's API has a `timeout_secs` field but it's currently advisory
		// only ("Optional client-side timeout hint. Currently accepted for
		// API compatibility." — islo API docs), so we have to enforce it
		// remotely. Assumes the sandbox image ships GNU coreutils, which is
		// true for the default islo runner and almost every standard Linux
		// image. On exceedance, `timeout` exits 124, which propagates through
		// the CLI as our exit code.
		const tmo =
			typeof options?.timeout === 'number' ? `timeout ${options.timeout} ` : '';
		const remote = `${tmo}${envPrefix}bash -lc ${q(cd + command)}`;

		const args = ['--output', 'json', 'use', this.name, '--', 'bash', '-lc', remote];
		return new Promise((resolve, reject) => {
			const child = spawn(this.cliPath, args, {
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on('data', (c) => out.push(c));
			child.stderr.on('data', (c) => err.push(c));
			child.on('error', (e) =>
				reject(
					new Error(
						`[flue:islo] failed to spawn '${this.cliPath}': ${e.message}. ` +
							`Install the islo CLI: https://docs.islo.dev/getting-started/installation`,
					),
				),
			);
			child.on('close', (code) => {
				resolve({
					stdout: Buffer.concat(out).toString('utf-8'),
					stderr: Buffer.concat(err)
						.toString('utf-8')
						.replace(/\n*Exit code: \d+\n?$/, ''),
					exitCode: code ?? 0,
				});
			});
		});
	}

	async readFile(path: string): Promise<string> {
		const r = await this.exec(`cat -- ${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] readFile ${path}: ${r.stderr}`);
		return r.stdout;
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const r = await this.exec(`base64 < ${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] readFile ${path}: ${r.stderr}`);
		return Uint8Array.from(Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64'));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
		const b64 = buf.toString('base64'); // single-quote-safe alphabet
		const r = await this.exec(
			`mkdir -p "$(dirname ${q(path)})" && printf %s '${b64}' | base64 -d > ${q(path)}`,
		);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] writeFile ${path}: ${r.stderr}`);
	}

	async stat(path: string): Promise<FileStat> {
		const r = await this.exec(`stat -c '%F|%s|%Y' ${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] stat ${path}: ${r.stderr}`);
		const [type = '', size = '0', mtime = '0'] = r.stdout.trim().split('|');
		return {
			isFile: type.startsWith('regular'),
			isDirectory: type === 'directory',
			isSymbolicLink: type === 'symbolic link',
			size: Number.parseInt(size, 10) || 0,
			mtime: new Date((Number.parseInt(mtime, 10) || 0) * 1000),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const r = await this.exec(`ls -A1 ${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] readdir ${path}: ${r.stderr}`);
		return r.stdout.split('\n').filter(Boolean);
	}

	async exists(path: string): Promise<boolean> {
		return (await this.exec(`test -e ${q(path)}`)).exitCode === 0;
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const r = await this.exec(`mkdir ${options?.recursive ? '-p ' : ''}${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] mkdir ${path}: ${r.stderr}`);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
		const r = await this.exec(`rm ${flags ? `-${flags} ` : ''}${q(path)}`);
		if (r.exitCode !== 0) throw new Error(`[flue:islo] rm ${path}: ${r.stderr}`);
	}
}

/**
 * Create a Flue sandbox factory from an islo sandbox name. The user owns
 * the sandbox lifecycle (`islo use <name>` to create, `islo rm <name>` to
 * delete); this factory just adapts it.
 */
export function islo(name: string, options?: IsloConnectorOptions): SandboxFactory {
	const cliPath = options?.cliPath ?? 'islo';
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? '/workspace';
			const api = new IsloSandboxApi(name, cliPath);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

None. The connector only uses `@flue/sdk` (already in the project) and
Node's built-in `child_process`.

## Required runtime: the islo CLI

The host must have the islo CLI on `PATH` — both on the user's machine for
local development and on whatever target they deploy to (a Node server,
container, or CI runner). The CLI is a native binary distributed for macOS
and Linux on `x86_64` and `aarch64`.

Direct the user to the official install instructions at
[docs.islo.dev/getting-started/installation](https://docs.islo.dev/getting-started/installation).
**Don't pipe the install script yourself** — the user should review and run
it. After install, they can verify with `islo --version`.

For container or CI deployments, the user will need to add the install step
to their image build or CI workflow.

## Authentication

The connector inherits whatever authentication the islo CLI already has.
Two options for the user:

- **Interactive login** (dev): `islo login` — opens a browser, caches a
  token in the OS keychain. The connector uses it via the CLI.
- **API key** (CI/server): `islo api-key create my-flue-key --show` and
  set `ISLO_API_KEY` in the environment. The CLI exchanges it for a
  short-lived session token on first call.

**Never invent a key value** — it must come from the user. For CI/server
runs, recommend `flue dev --env <file>` / `flue run --env <file>` to load
an `.env`-format file containing `ISLO_API_KEY`.

## Provisioning the sandbox

The connector adapts an existing sandbox. Tell the user to create one:

```bash
islo use my-sandbox -- true                                 # provision and exit
islo use my-sandbox --image docker.io/library/python:latest -- true
```

Pause idle sandboxes with `islo pause <name>` to save credit; the next
`exec()` resumes automatically.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { islo } from '../connectors/islo'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  const agent = await init({
    sandbox: islo('my-sandbox'),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install the islo CLI (if you didn't),
   run `islo login` (or make `ISLO_API_KEY` available at runtime per the
   Authentication section above), pre-provision a sandbox with
   `islo use <name>`, then run `flue dev` (or `flue run <agent>`) to try it.
