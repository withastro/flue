---
{
  "kind": "sandbox",
  "version": 1,
  "website": "https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/",
  "aliases": ["@cloudflare/shell"]
}
---

# Add a Flue Sandbox Adapter: Cloudflare Shell

You are an AI coding agent installing the Cloudflare Shell sandbox adapter
for a Flue Cloudflare-target project. Follow these instructions exactly.
Confirm with the user only when something is genuinely ambiguous.

## What this adapter does

Wraps an already-initialized `@cloudflare/shell` `Workspace` into Flue's
`SandboxFactory` interface. The adapter exposes a codemode-backed `code`
tool that runs JavaScript against the durable workspace through a Worker Loader
binding. The user owns workspace construction and hydration.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/cloudflare-shell.ts`.

If neither feels right, ask the user before writing. Create any missing parent
directories.

## File contents

Write this file verbatim. It requires a Cloudflare Worker target with a
`worker_loaders` binding.

```ts
// flue-blueprint: sandbox/cloudflare-shell@1
import {
	STATE_TYPES,
	Workspace,
	WorkspaceFileSystem,
	type FsStat as CfFsStat,
} from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
import {
	DynamicWorkerExecutor,
	resolveProvider,
	type DynamicWorkerExecutorOptions,
	type ResolvedProvider,
} from '@cloudflare/codemode';
import {
	type FileStat,
	type SandboxFactory,
	type SessionEnv,
	type SessionToolFactory,
	type ShellResult,
} from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export interface GetShellSandboxOptions {
	workspace: Workspace;
	loader: WorkerLoader;
	executor?: Pick<DynamicWorkerExecutorOptions, 'timeout' | 'globalOutbound' | 'modules'>;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
	if (!options?.workspace) {
		throw new Error(
			'[flue] getShellSandbox requires a workspace. Pass `getDefaultWorkspace()` for the common case, ' +
				'or construct your own with `new Workspace({ sql: ctx.storage.sql, ... })`.',
		);
	}
	if (!options.loader) {
		throw new Error(
			'[flue] getShellSandbox requires a WorkerLoader binding. Add this to your wrangler.jsonc:\n' +
				'  { "worker_loaders": [{ "binding": "LOADER" }] }\n' +
				'Then pass `loader: env.LOADER` to getShellSandbox(). Worker Loader is currently in beta — ' +
				'see https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/.',
		);
	}

	const { workspace, loader, executor: executorOptions } = options;
	const fs = new WorkspaceFileSystem(workspace);
	const executor = new DynamicWorkerExecutor({
		loader,
		...executorOptions,
	});
	const stateProvider = resolveProvider(stateTools(workspace));
	const toolFactory: SessionToolFactory = () => [createCodeTool(executor, stateProvider)];

	return {
		async createSessionEnv() {
			return createWorkspaceSessionEnv(workspace, fs, '/');
		},
		tools: toolFactory,
	};
}

function normalizePath(p: string): string {
	const parts = p.split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') result.pop();
		else result.push(part);
	}
	return `/${result.join('/')}`;
}

function createWorkspaceSessionEnv(
	workspace: Workspace,
	fs: WorkspaceFileSystem,
	cwd: string,
): SessionEnv {
	const normalizedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (normalizedCwd === '/') return normalizePath(`/${p}`);
		return normalizePath(`${normalizedCwd}/${p}`);
	};
	const exec = (): Promise<ShellResult> => {
		throw new Error(EXEC_NOT_SUPPORTED_MESSAGE);
	};

	return {
		exec,
		async readFile(path: string): Promise<string> {
			return fs.readFile(resolvePath(path));
		},
		async readFileBuffer(path: string): Promise<Uint8Array> {
			return fs.readFileBytes(resolvePath(path));
		},
		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			const write = async (): Promise<void> => {
				if (typeof content === 'string') await workspace.writeFile(resolved, content);
				else await workspace.writeFileBytes(resolved, content);
			};
			try {
				await write();
			} catch {
				const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
				try {
					await fs.mkdir(parent, { recursive: true });
				} catch {
				}
				await write();
			}
		},
		async stat(path: string): Promise<FileStat> {
			return adaptStat(await fs.stat(resolvePath(path)));
		},
		async readdir(path: string): Promise<string[]> {
			return fs.readdir(resolvePath(path));
		},
		async exists(path: string): Promise<boolean> {
			return fs.exists(resolvePath(path));
		},
		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await fs.mkdir(resolvePath(path), opts);
		},
		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			await fs.rm(resolvePath(path), opts);
		},
		cwd: normalizedCwd,
		resolvePath,
	};
}

const EXEC_NOT_SUPPORTED_MESSAGE =
	'[flue] The cf-shell sandbox does not support exec(). The agent\'s `code` tool runs JavaScript ' +
	'in an isolated Worker against the workspace; from your own code, use `session.fs` / `harness.fs` ' +
	'(readFile, writeFile, stat, readdir, etc.) — they route through the same Workspace. If you ' +
	'specifically need bash/grep/find or a real Linux environment, use `@cloudflare/sandbox` ' +
	'(Containers + mountBucket) instead.';

function adaptStat(s: CfFsStat): FileStat {
	return {
		isFile: s.type === 'file',
		isDirectory: s.type === 'directory',
		isSymbolicLink: s.type === 'symlink',
		size: s.size,
		mtime: s.mtime,
	};
}

const CodeParams = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				'A single async arrow function with the signature `async () => { ... return result; }`. ' +
				'Inside the body, call `state.*` to operate on the workspace (see the type declarations ' +
				'below). The function executes in an isolated Worker — no network, no DOM, no imports. ' +
				'Return whatever JSON-serializable value you want back; it is returned as the tool result.',
		},
	},
	required: ['code'],
};

function createCodeTool(
	executor: DynamicWorkerExecutor,
	stateProvider: ResolvedProvider,
) {
	return {
		name: 'code',
		label: 'Run Code',
		description: buildCodeToolDescription(),
		parameters: CodeParams,
		async execute(
			_toolCallId: string,
			params: unknown,
		) {
			const code = (params as { code: string }).code;
			const { result, error, logs } = await executor.execute(code, [stateProvider]);
			if (error) {
				const logsTail = logs?.length ? `\n\nlogs:\n${logs.join('\n')}` : '';
				throw new Error(`code tool failed: ${error}${logsTail}`);
			}
			const resultText = formatResult(result);
			const logsText = logs?.length ? `\n\n--- logs ---\n${logs.join('\n')}` : '';
			return {
				content: [{ type: 'text' as const, text: resultText + logsText }],
				details: logs?.length ? { logs } : {},
			};
		},
	};
}

function formatResult(result: unknown): string {
	if (result === undefined) return '(no result)';
	if (typeof result === 'string') return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function buildCodeToolDescription(): string {
	return [
		'Run a snippet of JavaScript inside an isolated Worker against a durable',
		'workspace filesystem. The snippet must be a single async arrow function:',
		'',
		'  async () => {',
		'    const text = await state.readFile("/notes.md");',
		'    await state.writeFile("/notes.md", text.toUpperCase());',
		'    return { bytes: text.length };',
		'  }',
		'',
		'Rules:',
		'- Write JavaScript, not TypeScript — no type annotations.',
		'- Do not use `import` statements. Everything you need is on `state`.',
		'- Always `return` the value you want back.',
		'- For multi-file refactors, prefer `state.planEdits()` + `state.applyEditPlan()` over many writes.',
		'- For tree-wide search/replace, use `state.replaceInFiles()` (transactional by default).',
		'- Network access (`fetch`, `connect`) is disabled. Do not attempt outbound HTTP.',
		'',
		'The `state` API (TypeScript declaration; the runtime is JavaScript):',
		'',
		'```typescript',
		STATE_TYPES,
		'```',
	].join('\n');
}

export function getDefaultWorkspace(): Workspace {
	const { storage } = getCloudflareContext();
	return new Workspace({ sql: storage.sql });
}
```

## Required dependencies

This adapter imports Cloudflare Shell and codemode. If the user's
`package.json` does not already list them, add them with the user's package
manager:

```bash
npm install @cloudflare/shell@^0.3.8 @cloudflare/codemode@^0.3.8
```

## Authentication

No provider API key is required. The project must run on Cloudflare Workers and
must configure a Worker Loader binding. Add this to `wrangler.jsonc` if it is
not already present:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

Worker Loader is currently beta-gated. Never invent Cloudflare account details
or tokens; the user authenticates through their existing Wrangler setup.

## Behavior and tradeoffs

This adapter is not Flue's default just-bash virtual sandbox. It replaces the
normal shell and file-manipulation tool set with a `code` tool that runs
JavaScript against the Workspace `state.*` API. Application code can still use
`session.fs` and `harness.fs` against the same Workspace; `session.shell()` and
`harness.shell()` throw.

If the user needs Linux commands, language toolchains, or R2 keys exposed as
mounted filesystem paths, use `@cloudflare/sandbox` Containers with
`mountBucket` instead. Application-specific data loading into the Workspace
belongs outside this adapter.

## Wiring it into a workflow

```ts
import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';

export const route: WorkflowRouteHandler = async (_c, next) => next();

interface Env {
  LOADER: WorkerLoader;
}

export async function run({ init, env }: FlueContext<unknown, Env>) {
  const workspace = getDefaultWorkspace();
  const harness = await init({
    sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
    model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
  });
  const session = await harness.session();
  return await session.prompt('Use the code tool to list the workspace root.');
}
```

## Verify

1. Run the user's typechecker.
2. Confirm the import path matches where you wrote `cloudflare-shell.ts`.
3. Confirm `wrangler.jsonc` has a `worker_loaders` binding matching the code.
4. Tell the user to use `flue dev --target cloudflare`; if local Wrangler cannot simulate Worker Loader, use remote dev or deploy a preview Worker.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
