---
{
  "category": "sandbox",
  "website": "https://www.tigrisdata.com/"
}
---

# Add a Flue Connector: Tigris

You are an AI coding agent installing the Tigris sandbox connector for a Flue
project. Follow these instructions exactly. Confirm with the user only when
something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Gives a Flue agent a **durable file sandbox** backed by a [Tigris](https://www.tigrisdata.com/)
bucket (Tigris is globally-distributed, S3-compatible object storage). Unlike
Flue's default in-memory sandbox, files written here **survive between runs** —
the agent picks up where it left off.

The agent reads and writes files against the bucket through Flue's standard file
tools. It also gets a **`checkpoint` tool**: the agent can snapshot the whole
workspace before a risky step and you can roll back later. Snapshots are
version markers on the bucket — they create no extra buckets and need no
cleanup.

This connector is **file-only**: it does not run a Linux shell (`exec` throws a
clear message). If you need `git`/`npm`/compilers, use a VM provider (E2B,
Daytona, Modal) and keep Tigris as durable storage behind it — see "Pairing
with a real shell" below.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the connector to `<source-dir>/connectors/tigris.ts`.

If neither feels right, ask the user before writing. Create any missing parent
directories.

## File contents

Write this file verbatim. It conforms to Flue's published `SandboxApi` contract.

```ts
/**
 * Tigris connector for Flue.
 *
 * A durable file sandbox backed by a Tigris bucket. Files persist across runs.
 * The agent gets a `checkpoint` tool to snapshot the workspace; roll back with
 * agent-kit `restore()` from your own workflow code.
 *
 * @example
 * ```typescript
 * import { createAgent, init } from '@flue/runtime';
 * import { getTigrisSandbox } from './connectors/tigris';
 *
 * const agent = createAgent(() => ({
 *   sandbox: getTigrisSandbox({ bucket: 'my-agent-workspace' }),
 *   model: 'anthropic/claude-sonnet-4-6',
 * }));
 * ```
 */
import { Type, createSandboxSessionEnv } from '@flue/runtime';
import type {
	FileStat,
	SandboxApi,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
} from '@flue/runtime';
import { get, head, list, put, remove } from '@tigrisdata/storage';
import { checkpoint, listCheckpoints } from '@tigrisdata/agent-kit';
import type { TigrisConfig } from '@tigrisdata/storage';

export interface GetTigrisSandboxOptions {
	/** Target bucket. Falls back to TIGRIS_STORAGE_BUCKET if omitted. */
	bucket?: string;
	/** Credentials / endpoint. Falls back to TIGRIS_STORAGE_* env vars. */
	config?: TigrisConfig;
	/** Expose `checkpoint` / `list_checkpoints` tools to the agent. Default true. */
	checkpointTools?: boolean;
}

// S3 keys have no leading slash; Flue passes absolute paths.
function keyOf(path: string): string {
	return path.replace(/^\/+/, '');
}

function dirPrefix(path: string): string {
	const key = keyOf(path);
	if (key === '') return '';
	return key.endsWith('/') ? key : `${key}/`;
}

function basename(key: string): string {
	return key.replace(/\/+$/, '').split('/').pop() ?? '';
}

class TigrisSandboxApi implements SandboxApi {
	constructor(private readonly config: TigrisConfig) {}

	async readFile(path: string): Promise<string> {
		const { data, error } = await get(keyOf(path), 'string', { config: this.config });
		if (error || data === undefined) throw error ?? new Error(`ENOENT: ${path}`);
		return data;
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const { data, error } = await get(keyOf(path), 'file', { config: this.config });
		if (error || data === undefined) throw error ?? new Error(`ENOENT: ${path}`);
		return new Uint8Array(await data.arrayBuffer());
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const body = typeof content === 'string' ? content : Buffer.from(content);
		const { error } = await put(keyOf(path), body, { config: this.config, allowOverwrite: true });
		if (error) throw error;
	}

	async stat(path: string): Promise<FileStat> {
		const { data } = await head(keyOf(path), { config: this.config });
		if (data) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				size: data.size,
				mtime: data.modified, // note: Tigris LastModified is second-resolution
			};
		}
		// Not an object — treat as a directory if anything lives under the prefix.
		const listing = await list({ prefix: dirPrefix(path), limit: 1, config: this.config });
		if (listing.data && (listing.data.items.length > 0 || listing.data.commonPrefixes.length > 0)) {
			return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mtime: new Date(0) };
		}
		throw new Error(`ENOENT: ${path}`);
	}

	async readdir(path: string): Promise<string[]> {
		const prefix = dirPrefix(path);
		const names = new Set<string>();
		let token: string | undefined;
		do {
			const { data, error } = await list({
				prefix,
				delimiter: '/',
				paginationToken: token,
				config: this.config,
			});
			if (error || !data) throw error ?? new Error(`ENOENT: ${path}`);
			for (const item of data.items) {
				if (item.name === prefix) continue; // the directory's own empty-dir marker
				const name = basename(item.name);
				if (name) names.add(name);
			}
			for (const p of data.commonPrefixes) names.add(basename(p));
			token = data.hasMore ? data.paginationToken : undefined;
		} while (token);
		return [...names];
	}

	async exists(path: string): Promise<boolean> {
		const { data } = await head(keyOf(path), { config: this.config });
		if (data) return true;
		const listing = await list({ prefix: dirPrefix(path), limit: 1, config: this.config });
		return !!listing.data && (listing.data.items.length > 0 || listing.data.commonPrefixes.length > 0);
	}

	async mkdir(path: string): Promise<void> {
		// S3 has no real directories; write an empty marker key.
		const { error } = await put(dirPrefix(path), '', { config: this.config, allowOverwrite: true });
		if (error) throw error;
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		if (options?.recursive) {
			const prefix = dirPrefix(path);
			let token: string | undefined;
			do {
				const { data, error } = await list({ prefix, paginationToken: token, config: this.config });
				if (error || !data) {
					if (options.force) return;
					throw error ?? new Error(`ENOENT: ${path}`);
				}
				for (const item of data.items) await remove(item.name, { config: this.config });
				token = data.hasMore ? data.paginationToken : undefined;
			} while (token);
			return;
		}
		const { error } = await remove(keyOf(path), { config: this.config });
		if (error && !options?.force) throw error;
	}

	async exec(): Promise<never> {
		throw new Error(
			'[flue] The Tigris sandbox is file-only and does not run a shell. Use the file tools ' +
				'(read/write/stat/readdir/etc.) which route through your Tigris bucket. If you need ' +
				'bash/git/npm or a real Linux environment, use a VM provider (E2B, Daytona, Modal) and ' +
				'keep Tigris as durable storage behind it.',
		);
	}
}

const CheckpointParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: 'Optional label for this checkpoint snapshot.' }),
	),
});

function checkpointTools(bucket: string, config: TigrisConfig): SessionToolFactory {
	return () => [
		{
			name: 'checkpoint',
			label: 'Checkpoint Workspace',
			description:
				'Snapshot the entire Tigris workspace at its current state. Returns a snapshotId you ' +
				'(or the operator) can restore later. Cheap — creates no new bucket. Use before a ' +
				'risky multi-step change.',
			parameters: CheckpointParams,
			async execute(_id: string, params: unknown) {
				const name = (params as { name?: string }).name;
				const { data, error } = await checkpoint(bucket, { name, config });
				if (error || !data) throw error ?? new Error('checkpoint failed');
				return {
					content: [{ type: 'text' as const, text: `checkpoint created: ${data.snapshotId}` }],
					details: { snapshotId: data.snapshotId },
				};
			},
		},
		{
			name: 'list_checkpoints',
			label: 'List Checkpoints',
			description: 'List recent workspace checkpoints (snapshotId + optional name).',
			parameters: Type.Object({}),
			async execute() {
				const { data, error } = await listCheckpoints(bucket, { config });
				if (error || !data) throw error ?? new Error('list_checkpoints failed');
				const text = data.checkpoints.length
					? data.checkpoints.map((c) => `${c.snapshotId}${c.name ? ` (${c.name})` : ''}`).join('\n')
					: '(no checkpoints yet)';
				return { content: [{ type: 'text' as const, text }], details: { checkpoints: data.checkpoints } };
			},
		},
	];
}

export function getTigrisSandbox(options: GetTigrisSandboxOptions = {}): SandboxFactory {
	// Storage calls accept a config with `bucket` (the package's internal
	// TigrisStorageConfig); only the endpoint/auth half (TigrisConfig) is exported.
	const config: TigrisConfig & { bucket?: string } = { ...options.config };
	if (options.bucket) config.bucket = options.bucket;

	const bucket = config.bucket ?? process.env.TIGRIS_STORAGE_BUCKET;
	if (!bucket) {
		throw new Error(
			'[flue] getTigrisSandbox requires a bucket. Pass `{ bucket: "..." }` or set ' +
				'TIGRIS_STORAGE_BUCKET. Credentials come from `config` or TIGRIS_STORAGE_ACCESS_KEY_ID / ' +
				'TIGRIS_STORAGE_SECRET_ACCESS_KEY.',
		);
	}

	const api = new TigrisSandboxApi(config);
	const factory: SandboxFactory = {
		async createSessionEnv(): Promise<SessionEnv> {
			return createSandboxSessionEnv(api, '/');
		},
	};
	if (options.checkpointTools !== false) {
		factory.tools = checkpointTools(bucket, config);
	}
	return factory;
}
```

## Required dependencies

```bash
npm install @tigrisdata/storage @tigrisdata/agent-kit
```

## Authentication

Tigris uses S3-style credentials. Provide them via the `config` option or these
environment variables (loaded by `flue dev --env <file>` / `flue run --env <file>`):

```
TIGRIS_STORAGE_BUCKET=my-agent-workspace
TIGRIS_STORAGE_ACCESS_KEY_ID=...
TIGRIS_STORAGE_SECRET_ACCESS_KEY=...
# TIGRIS_STORAGE_ENDPOINT defaults to https://t3.storage.dev
```

Create a bucket and access key in the Tigris dashboard. Never invent keys; if
the project gives no signal on where secrets live, ask the user.

## Behavior and tradeoffs

- **Durable, not ephemeral.** Files persist in the bucket across runs. The
  agent does not get a clean slate unless you point it at a fresh bucket.
- **File-only.** `exec()` throws. The agent works through file tools, not bash.
- **Object-store semantics.** Directories are emulated via key prefixes and
  empty marker objects. `mtime` is second-resolution (S3 `LastModified`).
  Concurrent writers to the same key are last-writer-wins.
- **Checkpoints are cheap.** `checkpoint` creates a bucket snapshot (a version
  marker), not a copy — no cleanup needed.

## Restoring a checkpoint (operator-side)

Restore happens in your workflow code, not as an agent tool, because it
produces a new bucket rather than mutating the live one:

```ts
import { restore } from '@tigrisdata/agent-kit';

const { data } = await restore('my-agent-workspace', snapshotId);
// data.bucket is a fresh bucket seeded from the snapshot.
// Re-create the agent with getTigrisSandbox({ bucket: data.bucket }).
```

## Parallel / fan-out sessions (optional, opt-in)

For N agents exploring the same baseline in isolation, use copy-on-write forks.
**Forks are real buckets — tear them down when done.**

```ts
import { createForks, teardownForks } from '@tigrisdata/agent-kit';

const { data: forks } = await createForks('my-agent-workspace', 5);
try {
  // For each forks.forks[i], run an agent with
  //   getTigrisSandbox({ bucket: forks.forks[i].bucket })
} finally {
  if (forks) await teardownForks(forks);
}
```

## Pairing with a real shell (Phase 2 pattern)

If you need a genuine Linux shell, this connector is not enough on its own. Use
a VM sandbox (E2B / Daytona / Modal) for `exec`, and use Tigris as the durable
layer: hydrate the VM workspace from the bucket at start, sync results back at
the end, and use `checkpoint()` for rollback. Tigris gives you cheap snapshots
and copy-on-write forks that none of the VM providers offer.

## Wiring it into a workflow

```ts
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import { getTigrisSandbox } from '../connectors/tigris';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init }: FlueContext) {
  const agent = createAgent(() => ({
    sandbox: getTigrisSandbox({ bucket: 'my-agent-workspace' }),
    model: 'anthropic/claude-sonnet-4-6',
  }));
  const harness = await init(agent);
  const session = await harness.session();
  return await session.prompt(
    'Write a file notes.md with three bullet points, then checkpoint the workspace.',
  );
}
```

## Verify

1. Run the user's typechecker (`npx tsc --noEmit`). Fix anything you broke.
2. Confirm the import path matches where you wrote `tigris.ts`.
3. Confirm `TIGRIS_STORAGE_*` env vars (or a `config`) are set, then `flue dev`.
4. Smoke test: prompt the agent to write a file and read it back; confirm it
   persists by re-running without rewriting.
