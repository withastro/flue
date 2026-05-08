---
{
  "category": "sandbox",
  "website": "https://boxd.sh",
  "aliases": ["@boxd-sh/sdk"]
}
---

# Add a Flue Connector: boxd

You are an AI coding agent installing the boxd sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized boxd VM (created with the user's own
`@boxd-sh/sdk` `Compute` client) into Flue's `SandboxFactory` interface. The
user owns the boxd VM lifecycle; this connector just adapts the VM.

boxd ships microVMs, so each `Box` is a full Linux VM with persistent disk,
not a shared container. Cold start is sub-second and forks are even faster,
which makes it a good fit for per-session agents that want a real OS.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/boxd.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/boxd.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * boxd connector for Flue.
 *
 * Wraps an already-initialized boxd VM (a `Box` from `@boxd-sh/sdk`) into
 * Flue's SandboxFactory interface. The user creates and configures the VM
 * using the boxd SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Compute } from '@boxd-sh/sdk';
 * import { boxd } from './connectors/boxd';
 *
 * const client = new Compute({ apiKey: process.env.BOXD_API_KEY });
 * const box = await client.box.create({ name: 'my-agent' });
 * const agent = await init({ sandbox: boxd(box), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Box as BoxdBox } from '@boxd-sh/sdk';

export interface BoxdConnectorOptions {
	/**
	 * Default working directory for `exec()` calls when one isn't supplied
	 * per-call. Defaults to `/home/boxd` (the boxd VM default user's home).
	 */
	cwd?: string;
	/**
	 * How long to wait for the in-VM exec endpoint to come up before the
	 * first command, in milliseconds. boxd's `box.create()` returns once
	 * the VM is scheduled, but the agent inside it can take a moment more
	 * before exec calls succeed. Defaults to 30000 (30s); set to 0 to skip
	 * the probe entirely (useful when reusing a box you know is warm).
	 */
	readyTimeoutMs?: number;
}

/**
 * Poll `box.exec(['true'])` until it succeeds or the deadline passes.
 * boxd's create/fork return once the VM is scheduled; the in-VM agent
 * needs another moment before exec calls land. Resolves quietly on a
 * warm box (single successful probe) and throws on timeout.
 */
async function waitForReady(box: BoxdBox, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return;
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const probe = await box.exec(['true']);
			if (probe.exitCode === 0) return;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`[flue:boxd] VM ${box.name} did not become ready within ${timeoutMs}ms` +
			(lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
	);
}

/**
 * Quote a string for safe inclusion in a `bash -c` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements SandboxApi by wrapping the boxd TypeScript SDK.
 *
 * boxd's `box.exec()` takes an argv array and has no native `cwd` option,
 * so we route everything through `bash -lc` and prepend `cd <cwd>` when
 * the caller passes one. Filesystem operations that don't have a direct
 * SDK analogue (`stat`, `readdir`, `mkdir`, `rm`, `exists`) are implemented
 * via shell commands, the same pattern the Daytona connector uses.
 */
class BoxdSandboxApi implements SandboxApi {
	constructor(private box: BoxdBox) {}

	async readFile(path: string): Promise<string> {
		const bytes = await this.box.readFile(path);
		return new TextDecoder('utf-8').decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.box.readFile(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.box.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		// `stat -c` is GNU stat (default on the boxd Ubuntu image). Format:
		//   <type>|<size>|<mtime-epoch>
		const result = await this.runShell(
			`stat -c '%F|%s|%Y' ${shellQuote(path)}`,
		);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] stat failed for ${path}: ${result.stdout || result.stderr}`);
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
		// `ls -A` excludes `.` and `..` but lists dotfiles. `-1` forces one
		// entry per line so we don't have to parse columns.
		const result = await this.runShell(`ls -A1 ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:boxd] readdir failed for ${path}: ${result.stdout || result.stderr}`,
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
			throw new Error(`[flue:boxd] mkdir failed for ${path}: ${result.stdout || result.stderr}`);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags: string[] = [];
		if (options?.recursive) flags.push('-r');
		if (options?.force) flags.push('-f');
		const flagStr = flags.length ? `${flags.join('')} ` : '';
		const result = await this.runShell(`rm ${flagStr}${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:boxd] rm failed for ${path}: ${result.stdout || result.stderr}`);
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
		const wrapped = options?.cwd
			? `cd ${shellQuote(options.cwd)} && ${command}`
			: command;
		// Flue passes `timeout` in seconds (per the connector spec); boxd
		// expects milliseconds.
		const timeoutMs =
			typeof options?.timeout === 'number' ? options.timeout * 1000 : undefined;
		const result = await this.box.exec(['bash', '-lc', wrapped], {
			env: options?.env,
			timeoutMs,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized boxd VM.
 * The user owns the VM lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function boxd(box: BoxdBox, options?: BoxdConnectorOptions): SandboxFactory {
	let readyPromise: Promise<void> | undefined;
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? '/home/boxd';
			// Probe once per box, not once per session.
			readyPromise ??= waitForReady(box, options?.readyTimeoutMs ?? 30_000);
			await readyPromise;
			const api = new BoxdSandboxApi(box);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This connector imports from `@boxd-sh/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @boxd-sh/sdk
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This connector needs `BOXD_API_KEY` at runtime (a long-lived API key that
starts with `bxk_`). The boxd `Compute` client also accepts a short-lived
JWT via `BOXD_TOKEN` if the user prefers. **Never invent a value for
either** — they must come from the user.

API keys are issued from the boxd dashboard at `https://boxd.sh/account`.

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
import { Compute } from '@boxd-sh/sdk';
import { boxd } from '../connectors/boxd'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const client = new Compute({ apiKey: env.BOXD_API_KEY });
  const box = await client.box.create({ name: `agent-${Date.now()}` });

  try {
    const agent = await init({
      sandbox: boxd(box),
      model: 'anthropic/claude-sonnet-4-6',
    });
    const session = await agent.session();
    return await session.shell('uname -a');
  } finally {
    await client.close();
  }
}
```

Tip: forking is significantly faster than `create()` on boxd. If the user
runs many short-lived agents off the same base image, point them at
`client.box.fork(<base>, { name: ... })` and bake their tooling into the source
VM once.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@boxd-sh/sdk` (if you didn't),
   make sure `BOXD_API_KEY` is available at runtime (per the
   Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
