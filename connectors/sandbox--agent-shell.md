---
{
  "category": "sandbox",
  "website": "https://www.tigrisdata.com/docs/ai/agent-shell",
  "aliases": ["@tigrisdata/agent-shell"]
}
---

# Add a Flue Connector: Agent Shell

You are an AI coding agent installing the Tigris Agent Shell sandbox
connector for a Flue project. Follow these instructions exactly. Confirm
with the user only when something is genuinely ambiguous (e.g. an unusual
project layout).

## What this connector does

Wraps an already-initialized `TigrisShell` from `@tigrisdata/agent-shell`
into Flue's `SandboxFactory` interface. The user owns the shell
lifecycle; this connector just adapts it.

One thing worth knowing: writes stay in the shell's in-memory cache
until the user calls `shell.flush()`. This connector deliberately never
flushes on the user's behalf, so failure modes stay atomic. The user
decides when (and whether) to persist.

## Where to write the file

Pick the location based on the user's source layout (analogous to Next.js's
`src/` folder):

- **If `<root>/.flue/` exists**, write to `./.flue/connectors/agent-shell.ts`.
- **Otherwise**, write to `./connectors/agent-shell.ts` at the project root.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask
the user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the
published `SandboxApi` contract.

````ts
/**
 * Tigris Agent Shell connector for Flue.
 *
 * Wraps an already-initialized TigrisShell into Flue's SandboxFactory
 * interface. The user owns the shell lifecycle — construct the shell,
 * decide when to flush, and tear it down. Flue just adapts it.
 *
 * @example
 * ```typescript
 * import { TigrisShell } from '@tigrisdata/agent-shell';
 * import { agentShell } from './connectors/agent-shell';
 *
 * const shell = new TigrisShell({ bucket: process.env.TIGRIS_STORAGE_BUCKET });
 * const harness = await init({ sandbox: agentShell(shell), model: 'anthropic/claude-sonnet-4-6' });
 * const session = await harness.session();
 * ```
 */
import { createSandboxSessionEnv } from '@flue/sdk/sandbox';
import type { FileStat, SandboxApi, SandboxFactory, SessionEnv } from '@flue/sdk/sandbox';
import type { TigrisShell } from '@tigrisdata/agent-shell';

/**
 * Implements SandboxApi by delegating to the just-bash engine exposed by
 * TigrisShell. Writes stay in the cache until the user calls
 * `shell.flush()`.
 */
class AgentShellSandboxApi implements SandboxApi {
	constructor(private shell: TigrisShell) {}

	async readFile(path: string): Promise<string> {
		return this.shell.engine.fs.readFile(path);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return this.shell.engine.fs.readFileBuffer(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.shell.engine.fs.writeFile(path, content);
	}

	async stat(path: string): Promise<FileStat> {
		const s = await this.shell.engine.fs.stat(path);
		return {
			isFile: s.isFile,
			isDirectory: s.isDirectory,
			isSymbolicLink: s.isSymbolicLink,
			size: s.size,
			mtime: s.mtime,
		};
	}

	async readdir(path: string): Promise<string[]> {
		return this.shell.engine.fs.readdir(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.shell.engine.fs.exists(path);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.shell.engine.fs.mkdir(path, options);
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await this.shell.engine.fs.rm(path, options);
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
		// Flue passes timeout in seconds; translate to a signal and merge
		// with whatever the caller passed.
		const timeoutSignal =
			typeof options?.timeout === 'number'
				? AbortSignal.timeout(options.timeout * 1000)
				: undefined;
		const signal =
			options?.signal && timeoutSignal
				? AbortSignal.any([options.signal, timeoutSignal])
				: (options?.signal ?? timeoutSignal);

		const result = await this.shell.engine.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			signal,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		};
	}
}

/**
 * Create a Flue sandbox factory from an initialized TigrisShell.
 * The user owns the shell lifecycle; Flue wraps it into a SessionEnv for
 * agent use. Call `shell.flush()` when you want writes to persist to
 * Tigris — the connector deliberately does not flush for you.
 */
export function agentShell(shell: TigrisShell): SandboxFactory {
	return {
		async createSessionEnv({ cwd }: { id: string; cwd?: string }): Promise<SessionEnv> {
			const sandboxCwd = cwd ?? shell.engine.getCwd() ?? '/workspace';
			const api = new AgentShellSandboxApi(shell);
			return createSandboxSessionEnv(api, sandboxCwd);
		},
	};
}
````

## Required dependencies

This connector imports from `@tigrisdata/agent-shell`, so the user's
project needs to depend on it directly. If their `package.json` does not
already list it, add it:

```bash
npm install @tigrisdata/agent-shell
```

The recommended provisioning path (see "Wiring it into an agent" below)
uses `@tigrisdata/agent-kit` to create scoped, time-bounded workspaces
for each agent run. Install it alongside the shell unless the user has
told you they want to point at a long-lived bucket instead:

```bash
npm install @tigrisdata/agent-kit
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Authentication

The shell needs Tigris credentials at runtime. **Never invent values for
any env vars below** — they must come from the user.

The recommended path is `createWorkspace()` from `@tigrisdata/agent-kit`,
which provisions a fresh bucket with scoped credentials and a TTL for
each run. That call needs Tigris admin credentials so it can reach the
control plane: `TIGRIS_STORAGE_ACCESS_KEY_ID` and
`TIGRIS_STORAGE_SECRET_ACCESS_KEY`, or `TIGRIS_STORAGE_SESSION_TOKEN`
plus `TIGRIS_STORAGE_ORGANIZATION_ID` for session-token auth.

If the user wants a long-lived workspace instead (e.g. an assistant that
returns to the same files across runs), they manage the bucket and
credentials themselves and the shell reads `TIGRIS_STORAGE_BUCKET`
alongside the same key/secret pair.

Use your judgment for where these env vars should live. The project's
conventions, an `AGENTS.md`, or an existing setup (`.env`, `.dev.vars`,
a secret manager, CI vars, etc.) will usually tell you the right answer.
If nothing in the project gives you a clear signal, ask the user instead
of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share the matching snippet below so they can wire it up themselves.

### Recommended: with `@tigrisdata/agent-kit`

`createWorkspace` provisions a per-run bucket with scoped credentials,
a TTL, and snapshots enabled. `teardownWorkspace` reclaims everything
when the run is over, so a forgotten flush or a thrown error can never
leak agent data into a long-lived bucket.

The first argument is the bucket name, so it must follow S3 rules:
lowercase letters, digits, dots, and hyphens only. If you derive it from
a payload field, lowercase and strip unsafe characters first.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { createWorkspace, teardownWorkspace } from '@tigrisdata/agent-kit';
import { TigrisShell } from '@tigrisdata/agent-shell';
import { agentShell } from '../connectors/agent-shell'; // adjust path to match the user's layout
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const workspaceName = `agent-workspace-${payload.id}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-');
  const { data: workspace } = await createWorkspace(workspaceName, {
    ttl: { days: 1 },
    enableSnapshots: true,
    credentials: { role: 'Editor' },
  });

  const shell = new TigrisShell({
    accessKeyId: workspace.credentials?.accessKeyId,
    secretAccessKey: workspace.credentials?.secretAccessKey,
    bucket: workspace.bucket,
  });

  const harness = await init({
    sandbox: agentShell(shell),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await harness.session();

  try {
    const { data } = await session.prompt(payload.task, {
      schema: v.object({
        summary: v.string(),
        artifacts: v.array(v.string()),
      }),
    });
    // Flush before teardown so any snapshot or presigned link reflects
    // the work.
    await shell.flush();
    return data;
  } finally {
    await teardownWorkspace(workspace);
  }
}
```

### Alternate: static bucket via env vars

Use this when the user wants a workspace that persists across runs and
is willing to manage the bucket themselves.

```ts
import type { FlueContext } from '@flue/sdk/client';
import { TigrisShell } from '@tigrisdata/agent-shell';
import { agentShell } from '../connectors/agent-shell';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const shell = new TigrisShell({
    accessKeyId: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY,
    bucket: process.env.TIGRIS_STORAGE_BUCKET,
  });

  const harness = await init({
    sandbox: agentShell(shell),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await harness.session();

  try {
    const { data } = await session.prompt(payload.task, {
      schema: v.object({
        summary: v.string(),
        artifacts: v.array(v.string()),
      }),
    });
    return data;
  } finally {
    // Persist any cache writes back to Tigris. Skip this in the failure
    // branch if you want all-or-nothing semantics.
    await shell.flush();
  }
}
```

For fan-out patterns (parallel agents sharing a baseline bucket via
copy-on-write forks), see `createForks` / `teardownForks` in the
`@tigrisdata/agent-kit` docs.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: install `@tigrisdata/agent-shell` and
   (for the recommended workspace flow) `@tigrisdata/agent-kit` if you
   didn't, make sure the Tigris env vars are available at runtime (per
   the Authentication section above), and run `flue dev` (or
   `flue run <agent>`) to try it.
