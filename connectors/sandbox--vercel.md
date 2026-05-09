---
{
  "category": "sandbox",
  "website": "https://vercel.com/sandbox",
  "aliases": ["@vercel/sandbox"]
}
---

# Add a Flue Connector: Vercel Sandbox

You are an AI coding agent installing the Vercel Sandbox connector for a
Flue project. Follow these instructions exactly. Confirm with the user only
when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps an already-initialized Vercel Sandbox (created with the user's own
`@vercel/sandbox` client) into Flue's `SandboxFactory` interface. The user
owns the Vercel Sandbox lifecycle; this connector just adapts the sandbox.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/connectors/vercel.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./connectors/vercel.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SandboxApi` contract.

```ts
/**
 * Vercel Sandbox connector for Flue.
 *
 * Wraps an already-initialized Vercel Sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the Vercel
 * SDK directly — Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { Sandbox } from '@vercel/sandbox';
 * import { vercel } from './connectors/vercel';
 *
 * const sandbox = await Sandbox.create({ runtime: 'node24' });
 * const agent = await init({ sandbox: vercel(sandbox), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await agent.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/sdk/sandbox';
import type { Sandbox as VercelSandbox } from '@vercel/sandbox';

/**
 * Implements SandboxApi by wrapping the Vercel Sandbox SDK.
 */
class VercelSandboxApi implements SandboxApi {
	constructor(private sandbox: VercelSandbox) {}

	async readFile(path: string): Promise<string> {
		return this.sandbox.fs.readFile(path, 'utf8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buffer = await this.sandbox.fs.readFile(path);
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.sandbox.fs.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const stat = await this.sandbox.fs.stat(path);
		return {
			isFile: stat.isFile(),
			isDirectory: stat.isDirectory(),
			isSymbolicLink: stat.isSymbolicLink(),
			size: stat.size,
			mtime: stat.mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		return this.sandbox.fs.readdir(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.sandbox.fs.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.sandbox.fs.mkdir(path, options);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.sandbox.fs.rm(path, options);
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			signal?: AbortSignal;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// Vercel's SDK accepts an AbortSignal directly, so we forward both
		// `timeout` (synthesized as a signal) and the caller's `signal`.
		// Compose them with AbortSignal.any so whichever fires first wins:
		//   - timeout-only  → recoverable 124-shape ShellResult.
		//   - caller-only   → rethrow so the host abort propagates.
		//   - both          → if the caller's signal fired, propagate;
		//                     otherwise treat as timeout.
		const timeoutSignal =
			typeof options?.timeout === 'number'
				? AbortSignal.timeout(options.timeout * 1000)
				: undefined;
		const callerSignal = options?.signal;
		const signal =
			callerSignal && timeoutSignal
				? AbortSignal.any([callerSignal, timeoutSignal])
				: (callerSignal ?? timeoutSignal);

		try {
			const response = await this.sandbox.runCommand({
				cmd: 'bash',
				args: ['-c', command],
				cwd: options?.cwd,
				env: options?.env,
				signal,
			});
			const [stdout, stderr] = await Promise.all([
				response.stdout({ signal }),
				response.stderr({ signal }),
			]);
			return { stdout, stderr, exitCode: response.exitCode };
		} catch (err) {
			// If the caller's signal fired, rethrow so the host abort wins.
			if (callerSignal?.aborted) throw err;
			const aborted =
				timeoutSignal?.aborted &&
				(err === timeoutSignal.reason ||
					(err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')));
			if (aborted) {
				return {
					stdout: '',
					stderr: `[flue:vercel] Command timed out after ${options?.timeout} seconds.`,
					exitCode: 124,
				};
			}
			throw err;
		}
	}
}

/**
 * Create a Flue sandbox factory from an initialized Vercel Sandbox.
 * The user owns the sandbox lifecycle; Flue wraps it into a SessionEnv
 * for agent use.
 */
export function vercel(sandbox: VercelSandbox): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? '/vercel/sandbox';
			const api = new VercelSandboxApi(sandbox);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
```

## Required dependencies

This connector imports from `@vercel/sandbox`, so the user's project needs to
depend on it directly. If their `package.json` does not already list it,
add it:

```bash
npm install @vercel/sandbox
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

Vercel Sandbox uses Vercel's OIDC token system, not a simple API key. The
SDK reads `VERCEL_OIDC_TOKEN` from the environment automatically.

There are two paths, depending on where the sandbox runs:

- **In a Vercel deployment.** No setup needed — the platform injects the
  token automatically.
- **Locally or in a non-Vercel environment.** The user has to link their
  Vercel project and pull a development token:

  ```bash
  npx vercel link
  npx vercel env pull
  ```

  This drops a `.vercel/.env.development.local` (or similar) file with
  `VERCEL_OIDC_TOKEN` populated. The user will need to load that file at
  runtime — `flue dev --env <file>` and `flue run --env <file>` accept any
  `.env`-format file.

  For non-Vercel CI or other environments where OIDC isn't available, the
  user can use a Vercel access token instead. Direct them to Vercel's
  [authentication docs](https://vercel.com/docs/vercel-sandbox/concepts/authentication)
  for setup — **never invent a token value yourself**.

Tell the user which path applies to them; don't assume.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { Sandbox } from '@vercel/sandbox';
import { vercel } from '../connectors/vercel'; // adjust path to match the user's layout

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
  const sandbox = await Sandbox.create({ runtime: 'node24' });

  const agent = await init({
    sandbox: vercel(sandbox),
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
3. Tell the user the next steps: install `@vercel/sandbox` (if you didn't),
   make sure `VERCEL_OIDC_TOKEN` is available at runtime (per the
   Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
