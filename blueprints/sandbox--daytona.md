---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://daytona.io",
  "aliases": ["@daytona/sdk"]
}
---

# Add a Flue Sandbox Adapter: Daytona

You are an AI coding agent installing the Daytona sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized Daytona sandbox (created with the user's own
`@daytona/sdk` client) into Flue's `SandboxFactory` interface. The user owns
the Daytona client lifecycle; this adapter just adapts the sandbox.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/daytona.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
// flue-blueprint: sandbox/daytona@1
/**
 * Daytona adapter for Flue.
 *
 * Wraps an already-initialized Daytona sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the Daytona
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Daytona } from '@daytona/sdk';
 * import { daytona } from './sandboxes/daytona';
 *
 * const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
 * const sandbox = await client.create({ image: 'ubuntu:latest' });
 * const agent = defineAgent(() => ({ sandbox: daytona(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   const session = await harness.session();
 *   return await session.prompt('Inspect the workspace.');
 * }});
 * ```
 */
import { createSandboxSessionEnv, SandboxOperationUnsupportedError } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';

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
			isDirectory: info.isDir,
			size: info.size,
			mtime: new Date(info.modTime),
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
		if (options?.force) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Daytona',
				options: ['force'],
			});
		}
		await this.sandbox.fs.deleteFile(path, options?.recursive);
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
		const response = await this.sandbox.process.executeCommand(
			command,
			options?.cwd,
			options?.env,
			typeof options?.timeoutMs === 'number'
				? Math.ceil(options.timeoutMs / 1000)
				: undefined,
		);
		return {
			stdout: response.result ?? '',
			stderr: '',
			exitCode: response.exitCode ?? 0,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized Daytona sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const sandboxCwd = (await sandbox.getWorkDir()) ?? '/home/daytona';
			const api = new DaytonaSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This adapter imports from `@daytona/sdk`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @daytona/sdk@^0.187.0
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

This adapter needs `DAYTONA_API_KEY` at runtime. **Never invent a value
for it** — it must come from the user.

Use your judgment for where it should live. The project's conventions, an
`AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a secret manager,
CI vars, etc.) will usually tell you the right answer. If nothing in the
project gives you a clear signal, ask the user instead of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the
user is already working on an agent that this adapter is meant to plug
into, you can finish that work by wiring the adapter into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../sandboxes/daytona'; // adjust path to match the user's layout

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(async ({ env }) => {
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  return {
    sandbox: daytona(sandbox),
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

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the adapter matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@daytona/sdk` (if you didn't),
   make sure `DAYTONA_API_KEY` is available at runtime (per the
   Authentication section above), and run `flue dev` (or
   `flue run <workflow>`) to try it.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
