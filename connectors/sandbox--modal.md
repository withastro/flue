---
{
  "category": "sandbox",
  "website": "https://modal.com"
}
---

# Add a Flue Connector: Modal

You are an AI coding agent installing the Modal sandbox connector for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized Modal Sandbox (created with the user's own
`modal` JS SDK client) into Flue's `SandboxFactory` interface. The user owns
the Modal Sandbox lifecycle; this connector just adapts the sandbox.

A few things worth knowing about Modal that shape this connector:

- Modal's `sandbox.exec()` returns a long-running `ContainerProcess` with
  `stdout`/`stderr` streams, not a `{ stdout, stderr, exitCode }` result.
  The connector pipes both streams to completion and waits for the exit
  code so it conforms to Flue's `SandboxApi.exec` shape.
- Modal's filesystem API only exposes file open/read/write/close. There is
  no native `mkdir`, `rm`, `stat`, `readdir`, or `exists`, so those are
  implemented by shelling out (the same pattern the boxd connector uses).
  This means the user's image needs `bash` and basic GNU coreutils
  available — Modal's default `python:3.13-slim` and `alpine:3.21` images
  both work fine. (Alpine ships BusyBox `stat`, which the connector handles
  in the implementation below.)

## Where to write the file

Pick the location based on the user's source layout (analogous to Next.js's
`src/` folder):

- **If `<workspace>/.flue/` exists**, write to `./.flue/connectors/modal.ts`.
- **Otherwise**, write to `./connectors/modal.ts` at the workspace root.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * Modal connector for Flue.
 *
 * Wraps an already-initialized Modal Sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the Sandbox using the Modal
 * JS SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { ModalClient } from 'modal';
 * import { modal } from './connectors/modal';
 *
 * const client = new ModalClient();
 * const app = await client.apps.fromName('my-app', { createIfMissing: true });
 * const image = client.images.fromRegistry('python:3.13-slim');
 * const sandbox = await client.sandboxes.create(app, image);
 *
 * const agent = await init({ sandbox: modal(sandbox), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as ModalSandbox } from 'modal';

export interface ModalConnectorOptions {
	/**
	 * Default working directory for `exec()` calls when the caller doesn't
	 * pass one. Modal sandboxes don't have a strict notion of a "default
	 * cwd" — it's whatever the underlying image's WORKDIR is — so this is
	 * also the value Flue uses to resolve relative paths in the session.
	 * Defaults to "/".
	 */
	cwd?: string;
}

/**
 * Quote a string for safe inclusion in a `bash -lc` command.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements SandboxApi by wrapping the Modal JS SDK's Sandbox class.
 *
 * Modal's surface is intentionally thin: `sandbox.exec()` for processes
 * and `sandbox.open()` for individual files. There's no built-in `mkdir`,
 * `rm`, `readdir`, `stat`, or `exists`, so those are implemented via
 * `bash -lc` shell-outs. This is the same pattern the boxd connector uses.
 */
class ModalSandboxApi implements SandboxApi {
	constructor(private sandbox: ModalSandbox) {}

	async readFile(path: string): Promise<string> {
		const handle = await this.sandbox.open(path, 'r');
		try {
			const bytes = await handle.read();
			return new TextDecoder('utf-8').decode(bytes);
		} finally {
			await handle.close();
		}
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const handle = await this.sandbox.open(path, 'r');
		try {
			return await handle.read();
		} finally {
			await handle.close();
		}
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const handle = await this.sandbox.open(path, 'w');
		try {
			const data =
				typeof content === 'string' ? new TextEncoder().encode(content) : content;
			await handle.write(data);
			await handle.flush();
		} finally {
			await handle.close();
		}
	}

	async stat(path: string): Promise<FileStat> {
		// Try GNU stat first (works on Debian/Ubuntu/python:3.13-slim).
		// Fall back to BusyBox stat (Alpine). The format string differs:
		//   GNU:     %F gives "regular file" / "directory" / "symbolic link"
		//   BusyBox: %F gives the same words but is positional only with `-c`.
		// Both implementations accept `stat -c '%F|%s|%Y' <path>`.
		const result = await this.runShell(
			`stat -c '%F|%s|%Y' ${shellQuote(path)} 2>/dev/null`,
		);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			throw new Error(
				`[flue:modal] stat failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
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
				`[flue:modal] readdir failed for ${path}: ` +
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
				`[flue:modal] mkdir failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
			);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const flags: string[] = [];
		if (options?.recursive) flags.push('-r');
		if (options?.force) flags.push('-f');
		const flagStr = flags.length > 0 ? ` ${flags.join('')}` : '';
		const result = await this.runShell(`rm${flagStr} ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(
				`[flue:modal] rm failed for ${path}: ` +
					(result.stderr || result.stdout || `exit ${result.exitCode}`),
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
		// Modal's exec takes argv (no shell parsing), so wrap in `bash -lc`
		// so users can pass shell commands the way Flue's other connectors
		// accept them. `pipe` for stdout/stderr is required to read them
		// back; the default `ignore` discards output.
		const proc = await this.sandbox.exec(['bash', '-lc', command], {
			workdir: options?.cwd,
			env: options?.env,
			// Flue passes timeout in seconds; Modal expects milliseconds.
			timeoutMs: typeof options?.timeout === 'number' ? options.timeout * 1000 : undefined,
			stdout: 'pipe',
			stderr: 'pipe',
		});

		// Read both streams concurrently while the process runs, then wait
		// for the exit code. Reading first and then waiting will deadlock
		// on processes that fill their stderr buffer.
		const [stdout, stderr, exitCode] = await Promise.all([
			proc.stdout.readText(),
			proc.stderr.readText(),
			proc.wait(),
		]);
		return { stdout, stderr, exitCode };
	}
}

/**
 * Create a Flue sandbox factory from an initialized Modal Sandbox.
 * The user owns the Sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function modal(sandbox: ModalSandbox, options?: ModalConnectorOptions): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? options?.cwd ?? '/';
			const api = new ModalSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This connector imports from `modal`, so the user's project needs to depend
on it directly. If their `package.json` does not already list it, add it:

```bash
npm install modal
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

The Modal JS SDK requires Node 22 or later.

## Authentication

This connector needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` at runtime —
both are required, neither has a default. **Never invent values for them**
— they must come from the user.

There are two paths:

- **Locally.** The user can install the Modal CLI and run `modal setup` to
  drop credentials at `~/.modal.toml`, which the SDK reads automatically.
  No env vars needed in this case.
- **In CI / serverless / containers.** The user sets `MODAL_TOKEN_ID` and
  `MODAL_TOKEN_SECRET` directly in the environment.

Tokens are issued from the Modal dashboard at
`https://modal.com/settings/tokens`.

Use your judgment for where the secrets should live in the user's project.
Their conventions, an `AGENTS.md`, or an existing setup (`.env`,
`.dev.vars`, a secret manager, CI vars, etc.) will usually tell you the
right answer. If nothing in the project gives you a clear signal, ask the
user instead of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { ModalClient } from 'modal';
import { modal } from '../connectors/modal'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  // ModalClient reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (or ~/.modal.toml)
  // automatically.
  const client = new ModalClient();
  const app = await client.apps.fromName('my-flue-app', { createIfMissing: true });
  const image = client.images.fromRegistry('python:3.13-slim');
  const sandbox = await client.sandboxes.create(app, image);

  const agent = await init({
    sandbox: modal(sandbox),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();

  return await session.shell('uname -a');
}
```

Tip: if the user wants a faster start, prebuild a custom image with their
tooling baked in (see Modal's `image-building.ts` example) instead of
installing packages on every cold start.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `modal` (if you didn't), make sure
   `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are available at runtime (per
   the Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
