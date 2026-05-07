---
{
  "category": "sandbox",
  "website": "https://islo.dev",
  "aliases": ["islo.dev"]
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
local `islo` binary. It works on any host that has the islo CLI on `PATH`
(Node servers, GitHub Actions, GitLab CI). It does **not** work in JS-only
edge runtimes (Cloudflare Workers, Vercel Edge) — there's no child process.

## Where to write the file

- **`.flue/` layout**: `./.flue/connectors/islo.ts`
- **Root layout**: `./connectors/islo.ts`

Create any missing parent directories.

## File contents

Write this file verbatim.

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
	/**
	 * Cleanup behavior when the session is destroyed.
	 * - `false` (default): no cleanup, user manages the sandbox.
	 * - `true`: runs `islo rm <name> --force`.
	 * - Function: called on destroy.
	 */
	cleanup?: boolean | (() => Promise<void>);
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

			let cleanupFn: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanupFn = () =>
					new Promise<void>((resolve) => {
						const c = spawn(cliPath, ['rm', name, '--force'], {
							env: process.env,
							stdio: 'ignore',
						});
						c.on('error', () => resolve());
						c.on('close', () => resolve());
					});
			} else if (typeof options?.cleanup === 'function') {
				cleanupFn = options.cleanup;
			}

			return createSandboxSessionEnv(api, sandboxCwd, cleanupFn);
		},
	};
}
```

## Required dependencies

None. The connector only uses `@flue/sdk` (already in the project) and
Node's built-in `child_process`.

## Required runtime: the islo CLI

The host must have the islo CLI on `PATH`. Install it once:

```bash
curl -fsSL https://docs.islo.dev/install.sh | sh
```

See [docs.islo.dev/getting-started/installation](https://docs.islo.dev/getting-started/installation)
for platform-specific options. Verify with `islo --version`.

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

```ts
import type { FlueContext } from '@flue/sdk/client';
import { islo } from '../connectors/islo';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({
    sandbox: islo(payload.sandbox ?? 'my-sandbox'),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();
  return await session.shell('uname -a; pwd');
}
```

## Verify

1. `npx tsc --noEmit` — connector typechecks.
2. Confirm the import path matches where you wrote the file.
3. Tell the user: install the islo CLI if they haven't, run `islo login`
   (or set `ISLO_API_KEY`), pre-provision a sandbox with `islo use <name>`,
   then `flue dev` (or `flue run <agent>`).
