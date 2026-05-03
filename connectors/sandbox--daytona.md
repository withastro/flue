---
{
  "category": "sandbox",
  "website": "https://daytona.io"
}
---

# Add a Flue Connector: Daytona

You are an AI coding agent installing the Daytona sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized Daytona sandbox (created with the user's own
`@daytona/sdk` client) into Flue's `SandboxFactory` interface. The user owns
the Daytona client lifecycle; this connector just adapts the sandbox.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/daytona.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/daytona.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * Daytona connector for Flue.
 *
 * Wraps an already-initialized Daytona sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the Daytona
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Daytona } from '@daytona/sdk';
 * import { daytona } from './connectors/daytona';
 *
 * const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
 * const sandbox = await client.create({ image: 'ubuntu:latest' });
 * const agent = await init({ sandbox: daytona(sandbox), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';

// ─── Options ────────────────────────────────────────────────────────────────

export interface DaytonaConnectorOptions {
	/**
	 * Cleanup behavior when the session is destroyed.
	 *
	 * - `false` (default): No cleanup — user manages the sandbox lifecycle.
	 * - `true`: Calls `sandbox.delete()` on session destroy.
	 * - Function: Calls the provided function on session destroy.
	 */
	cleanup?: boolean | (() => Promise<void>);
}

// ─── DaytonaSandboxApi ──────────────────────────────────────────────────────

/**
 * Implements SandboxApi by wrapping Daytona's TypeScript SDK.
 */
class DaytonaSandboxApi implements SandboxApi {
	constructor(private sandbox: DaytonaSandbox) {}

	async readFile(path: string): Promise<string> {
		const buffer = await this.sandbox.fs.downloadFile(path);
		return buffer.toString('utf-8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await this.sandbox.fs.downloadFile(path);
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const buffer =
			typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
		await this.sandbox.fs.uploadFile(buffer, path);
	}

	async stat(path: string): Promise<FileStat> {
		const info = await this.sandbox.fs.getFileDetails(path);
		return {
			isFile: !info.isDir,
			isDirectory: info.isDir ?? false,
			isSymbolicLink: false,
			size: info.size ?? 0,
			mtime: info.modTime ? new Date(info.modTime) : new Date(),
		};
	}

	async readdir(path: string): Promise<string[]> {
		const entries = await this.sandbox.fs.listFiles(path);
		return entries.map((e) => e.name).filter((name): name is string => !!name);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.sandbox.fs.getFileDetails(path);
			return true;
		} catch {
			return false;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (options?.recursive) {
			await this.exec(`mkdir -p '${path.replace(/'/g, "'\\''")}'`);
			return;
		}
		await this.sandbox.fs.createFolder(path, '755');
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.sandbox.fs.deleteFile(path, options?.recursive);
	}

	async exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const response = await this.sandbox.process.executeCommand(
			command,
			options?.cwd,
			options?.env,
			options?.timeout,
		);
		return {
			stdout: response.result ?? '',
			stderr: '',
			exitCode: response.exitCode ?? 0,
		};
	}
}

// ─── Connector ──────────────────────────────────────────────────────────────

/**
 * Create a Flue sandbox factory from an initialized Daytona sandbox.
 *
 * The user creates the sandbox using the Daytona SDK directly, then
 * passes it here. Flue wraps it into a SessionEnv for agent use.
 *
 * @param sandbox - An initialized Daytona Sandbox instance.
 * @param options - Connector options (cleanup behavior, etc.).
 */
export function daytona(
	sandbox: DaytonaSandbox,
	options?: DaytonaConnectorOptions,
): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? (await sandbox.getWorkDir()) ?? '/home/daytona';
			const api = new DaytonaSandboxApi(sandbox);

			// Resolve cleanup function
			let cleanupFn: (() => Promise<void>) | undefined;
			if (options?.cleanup === true) {
				cleanupFn = async () => {
					try {
						await sandbox.delete();
					} catch (err) {
						console.error('[flue:daytona] Failed to delete sandbox:', err);
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

This connector imports from `@daytona/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @daytona/sdk
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This connector needs `DAYTONA_API_KEY` at runtime. **Never invent a value
for it** — it must come from the user.

Use your judgment for where it should live. The project's conventions, an
`AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a secret manager,
CI vars, etc.) will usually tell you the right answer. If nothing in the
project gives you a clear signal, ask the user instead of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../connectors/daytona'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init, env }: FlueContext) {
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();

  const agent = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
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
3. Tell the user the next steps: install `@daytona/sdk` (if you didn't),
   make sure `DAYTONA_API_KEY` is available at runtime (per the
   Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
