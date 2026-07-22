---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://blaxel.ai",
  "aliases": ["@blaxel/core"]
}
---

# Add a Flue Sandbox Adapter: Blaxel

You are an AI coding agent installing the Blaxel sandbox adapter for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this adapter does

Wraps an already-initialized Blaxel `SandboxInstance` (created with the
user's own `@blaxel/core` client) into Flue's `SandboxFactory` interface.
The user owns sandbox creation, identity, retention, and cleanup; this
adapter only maps its filesystem and process APIs into Flue.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/blaxel.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract and the published `@blaxel/core` package.

```ts
// flue-blueprint: sandbox/blaxel@1
/**
 * Blaxel adapter for Flue.
 *
 * Wraps an initialized Blaxel SandboxInstance into Flue's SandboxFactory
 * interface. The application creates and owns the sandbox; Flue adapts it.
 *
 * @example
 * ```typescript
 * import { SandboxInstance } from '@blaxel/core';
 * import { blaxel } from './sandboxes/blaxel';
 *
 * const sandbox = await SandboxInstance.createIfNotExists({
 *   name: 'my-flue-sandbox',
 *   image: 'blaxel/base-image:latest',
 *   memory: 4096,
 *   region: 'us-pdx-1',
 *   ttl: '24h',
 * });
 * const agent = defineAgent(() => ({ sandbox: blaxel(sandbox), model: 'anthropic/claude-sonnet-4-6' }));
 * export default defineWorkflow({ agent, async run({ harness }) {
 *   return await (await harness.session()).prompt('Inspect the workspace.');
 * }});
 * ```
 */
import { createSandboxSessionEnv, SandboxOperationUnsupportedError } from '@flue/runtime';
import type { FileStat, SandboxApi, SandboxFactory, SessionEnv } from '@flue/runtime';
import type { SandboxInstance } from '@blaxel/core';

function parentAndName(path: string): { parent: string; name: string } {
	const withoutTrailingSlash = path.replace(/\/+$/, '');
	const normalized = withoutTrailingSlash.length === 0 ? '/' : withoutTrailingSlash;
	const separator = normalized.lastIndexOf('/');
	return {
		parent: separator <= 0 ? '/' : normalized.slice(0, separator),
		name: normalized.slice(separator + 1),
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Implements SandboxApi with Blaxel's filesystem and process APIs. */
class BlaxelSandboxApi implements SandboxApi {
	constructor(private sandbox: SandboxInstance) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.fs.read(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const blob = await this.sandbox.fs.readBinary(path);
		return new Uint8Array(await blob.arrayBuffer());
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		if (typeof content === 'string') {
			await this.sandbox.fs.write(path, content);
			return;
		}
		await this.sandbox.fs.writeBinary(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const { parent, name } = parentAndName(path);
		if (name.length === 0) {
			await this.sandbox.fs.ls('/');
			return { isFile: false, isDirectory: true };
		}

		const directory = await this.sandbox.fs.ls(parent);
		const file = directory.files.find((entry) => entry.name === name);
		if (file) {
			const mtime = new Date(file.lastModified);
			return {
				isFile: true,
				isDirectory: false,
				size: file.size,
				...(Number.isNaN(mtime.getTime()) ? {} : { mtime }),
			};
		}
		if (directory.subdirectories.some((entry) => entry.name === name)) {
			return { isFile: false, isDirectory: true };
		}
		throw new Error(`[flue:blaxel] Path not found: ${path}`);
	}

	async readdir(path: string): Promise<string[]> {
		const directory = await this.sandbox.fs.ls(path);
		return [
			...directory.subdirectories.map((entry) => entry.name),
			...directory.files.map((entry) => entry.name),
		];
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (!options?.recursive) {
			await this.sandbox.fs.mkdir(path);
			return;
		}
		const result = await this.exec(`mkdir -p -- ${shellQuote(path)}`);
		if (result.exitCode !== 0) {
			throw new Error(`[flue:blaxel] Could not create ${path}: ${result.stderr}`);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.force) {
			throw new SandboxOperationUnsupportedError({
				operation: 'rm',
				provider: 'Blaxel',
				options: ['force'],
			});
		}
		await this.sandbox.fs.rm(path, options?.recursive ?? false);
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
		const result = await this.sandbox.process.exec({
			command,
			workingDir: options?.cwd,
			env: options?.env,
			waitForCompletion: true,
			timeout:
				typeof options?.timeoutMs === 'number'
					? Math.ceil(options.timeoutMs / 1000)
					: undefined,
		});
		return {
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			exitCode: result.exitCode ?? 0,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized Blaxel sandbox.
 * The application owns the sandbox lifecycle; Flue wraps it into a
 * SessionEnv rooted at Blaxel's default working directory.
 */
export function blaxel(sandbox: SandboxInstance): SandboxFactory {
	return {
		async createSessionEnv(): Promise<SessionEnv> {
			const api = new BlaxelSandboxApi(sandbox);
			return createSandboxSessionEnv(api, '/blaxel');
		},
	};
}
```

## Required dependencies

This adapter imports from `@blaxel/core`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @blaxel/core@^0.3.6
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

For local development, the preferred path is to authenticate the Blaxel CLI
with `bl login <workspace>`; `@blaxel/core` discovers that configuration.
For CI or another non-Blaxel host, provide `BL_WORKSPACE` and `BL_API_KEY` at
runtime. Workloads already running on Blaxel authenticate automatically.

Never invent credential values. Follow the project's established secret
conventions. If no convention exists, ask the user instead of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this adapter looks like inside a Flue agent. If the user is
already working on an agent that this adapter is meant to plug into, finish
that work by wiring the adapter into it. Otherwise, share this snippet so they
can wire it up themselves.

```ts
import { SandboxInstance } from '@blaxel/core';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { blaxel } from '../sandboxes/blaxel'; // adjust for the user's layout

export const route: WorkflowRouteHandler = async (_c, next) => next();

const sandbox = await SandboxInstance.createIfNotExists({
  name: 'my-flue-sandbox',
  image: 'blaxel/base-image:latest',
  memory: 4096,
  region: 'us-pdx-1',
  ttl: '24h',
});

const agent = defineAgent(() => ({
  sandbox: blaxel(sandbox),
  model: 'anthropic/claude-sonnet-4-6',
}));

export default defineWorkflow({
  agent,
  run: async ({ harness }) => {
    const session = await harness.session();
    return await session.shell('uname -a');
  },
});
```

The application is responsible for deleting or retaining the sandbox. The
adapter deliberately does not call `sandbox.delete()` when a Flue harness
closes.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path used for the adapter matches its actual location.
3. If credentials are required, confirm the application can authenticate
   without printing them.
4. Exercise one text write/read, one binary write/read, directory listing,
   recursive directory creation, removal, and one shell command.
5. Tell the user that their application owns sandbox cleanup and retention.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-07-22

Initial version.
