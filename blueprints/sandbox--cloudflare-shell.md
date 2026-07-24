---
{
  "kind": "sandbox",
  "version": 3,
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
`SandboxFactory` interface. The adapter composes the standard file tools
(`read`, `write`, `edit` — they route through the workspace) with a
codemode-backed `code` tool that runs JavaScript against the durable
workspace through a Worker Loader binding. The user owns workspace
construction and hydration.

## Where to write the file

Select the first existing source directory: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Write the adapter to `<source-dir>/sandboxes/cloudflare-shell.ts`.

If neither feels right, ask the user before writing. Create any missing parent
directories.

## File contents

Write this file verbatim. It requires a Cloudflare Worker target with a
`worker_loaders` binding.

```ts
// flue-blueprint: sandbox/cloudflare-shell@3
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
	createEditTool,
	createReadTool,
	createWriteTool,
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

/**
 * The environment a cf-shell agent runs in: the generic `SessionEnv` file
 * verbs route through the workspace, and the workspace itself rides along as
 * the sandbox's native surface. Narrow to it with {@link shellWorkspace}.
 */
export interface ShellSandboxEnv extends SessionEnv {
	readonly workspace: Workspace;
}

/**
 * Narrow an agent's `harness.sandbox` to this sandbox's native surface — the
 * `@cloudflare/shell` {@link Workspace} — with a runtime check. Throws when
 * the agent runs on a different sandbox.
 */
export function shellWorkspace(sandbox: SessionEnv): Workspace {
	const workspace = (sandbox as Partial<ShellSandboxEnv>).workspace;
	if (!(workspace instanceof Workspace)) {
		throw new Error(
			'[flue] shellWorkspace(harness.sandbox) requires the cf-shell sandbox — this agent runs on a different environment.',
		);
	}
	return workspace;
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
	// Compose the standard file tools (they need only the SessionEnv file
	// verbs, which route through the workspace) with this sandbox's native
	// codemode tool. The exec-backed standard tools (bash/grep/glob) stay
	// out — this env has no shell.
	const toolFactory: SessionToolFactory = (env) => [
		createReadTool(env),
		createWriteTool(env),
		createEditTool(env),
		createCodeTool(executor, stateProvider),
	];

	return {
		async createSessionEnv(): Promise<ShellSandboxEnv> {
			return { ...createWorkspaceSessionEnv(workspace, fs, '/'), workspace };
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
	"[flue] The cf-shell sandbox does not support exec(). The agent's `code` tool runs JavaScript " +
	'in an isolated Worker against the workspace; from your own code, use the file verbs on ' +
	'`harness.sandbox` (readFile, writeFile, stat, readdir, etc.) or narrow to the native surface ' +
	'with `shellWorkspace(harness.sandbox)` — both route through the same Workspace. If you ' +
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
				'A string containing one self-contained async arrow function, for example ' +
				"`async () => await state.readFile('/notes.md')`. Must be plain JavaScript " +
				'(no TypeScript annotations). Only the `state` object is in scope — no other ' +
				'tools, no Node.js APIs, no imports. Batch multiple operations with Promise.all ' +
				'inside one function instead of issuing parallel code calls. Return a ' +
				'JSON-serializable value; it is returned as the tool result.',
		},
	},
	required: ['code'],
};

// Cloudflare allows at most 4 concurrent dynamic-worker invocations per
// request. A turn that batches more `code` calls than that would fail the
// surplus with "Too many concurrent dynamic workers" — queue them above a
// cap of 3 instead (headroom for anything else in the request that holds a
// dynamic worker).
const MAX_CONCURRENT_CODE_EXECUTIONS = 3;
let activeCodeExecutions = 0;
const codeExecutionWaiters: Array<() => void> = [];

async function withCodeExecutionSlot<T>(run: () => Promise<T>): Promise<T> {
	while (activeCodeExecutions >= MAX_CONCURRENT_CODE_EXECUTIONS) {
		await new Promise<void>((resolve) => codeExecutionWaiters.push(resolve));
	}
	activeCodeExecutions++;
	try {
		return await run();
	} finally {
		activeCodeExecutions--;
		codeExecutionWaiters.shift()?.();
	}
}

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
			const { result, error, logs } = await withCodeExecutionSlot(() =>
				executor.execute(code, [stateProvider]),
			);
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

// Each rule below pre-empts an observed model failure bucket from production
// use (Sentry, 2026-06/07): nested `state` shapes, native agent tools invoked
// inside `code`, Node require()/API usage, guessed file paths, parallel
// code-call bursts, and generated-JavaScript syntax/identifier defects.
function buildCodeToolDescription(): string {
	return [
		'Run one JavaScript snippet in an isolated Worker against the durable',
		'workspace filesystem. The snippet must be a single, self-contained async',
		'arrow function:',
		'',
		'  async () => {',
		'    const text = await state.readFile("/notes.md");',
		'    await state.writeFile("/notes.md", text.toUpperCase());',
		'    return { bytes: text.length };',
		'  }',
		'',
		'To touch several files, batch the work inside ONE call (Promise.all for',
		'reads) instead of issuing parallel code calls:',
		'',
		'  async () => {',
		'    const [a, b] = await Promise.all([',
		'      state.readFile("/docs/a.md"),',
		'      state.readFile("/docs/b.md"),',
		'    ]);',
		'    return { a, b };',
		'  }',
		'',
		'Rules — each violation fails the call:',
		'- `state` is the ONLY global beyond standard JavaScript built-ins. It is a',
		'  flat object of async functions (declaration below); there is no state.fs,',
		'  state.workspace, or any other nested namespace.',
		'- Your other agent tools (read, write, edit, task, ...) DO NOT exist inside',
		'  this snippet. Call them as separate direct tool calls, never from code.',
		'- This is an isolated Worker, not Node.js: require(), import, fs, path,',
		'  process, and Buffer do not exist. Network access (fetch, connect) is',
		'  disabled — do not attempt outbound HTTP.',
		'- Only use paths you have seen — from earlier reads or state.readdir().',
		'  Never guess or construct a path from an ID or a name.',
		'- Write plain JavaScript (no TypeScript annotations) and declare every',
		'  variable you use. Keep the body simple; do analysis in your reply, not',
		'  in code.',
		'- Always `return` the value you want back; it must be JSON-serializable.',
		'- For multi-file refactors, prefer `state.planEdits()` + `state.applyEditPlan()` over many writes.',
		'- For tree-wide search/replace, use `state.replaceInFiles()` (transactional by default).',
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
	return new Workspace({ sql: storage.sql as SqlStorage });
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

This adapter is not Flue's default just-bash virtual sandbox. Its `tools`
factory keeps the standard file tools (`read`/`write`/`edit`, composed from
Flue's exported per-tool factories) and swaps the shell-backed tools
(`bash`/`grep`/`glob`) for a `code` tool that runs JavaScript against the
Workspace `state.*` API. Application code uses the file verbs on
`harness.sandbox` against the same Workspace, or narrows to the native
surface with `shellWorkspace(harness.sandbox)`; `harness.sandbox.exec()`
throws.

If the user needs Linux commands, language toolchains, or R2 keys exposed as
mounted filesystem paths, use `@cloudflare/sandbox` Containers with
`mountBucket` instead. Application-specific data loading into the Workspace
belongs outside this adapter.

## Wiring it into an agent

```ts
'use agent';
import { env } from 'cloudflare:workers';
import { useModel, useSandbox } from '@flue/runtime';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';

interface Env {
  LOADER: WorkerLoader;
}

const { LOADER } = env as unknown as Env;

export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  useSandbox(getShellSandbox({ workspace: getDefaultWorkspace(), loader: LOADER }));
  return 'You explore and edit the mounted workspace with the file tools and the `code` tool.';
}
```

The `'use agent'` directive at the top is what registers the module with
the application. Mount the agent's HTTP surface explicitly in `app.ts`
(`app.route('/agents/<name>', createAgentRouter(Assistant))`, with
`createAgentRouter` from `@flue/runtime/routing`) if it needs an endpoint —
`dispatch()` needs no mount.

## Verify

1. Run the user's typechecker.
2. Confirm the import path matches where you wrote `cloudflare-shell.ts`.
3. Confirm `wrangler.jsonc` has a `worker_loaders` binding matching the code.
4. Tell the user to use `vite dev` (the Cloudflare target comes from the `cloudflare()` plugin in `vite.config.ts`); if local Wrangler cannot simulate Worker Loader, use remote dev or deploy a preview Worker with `vite build && wrangler deploy`.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.

### Version 2 — 2026-07-12

Bounded `code` tool concurrency. Cloudflare allows at most 4 concurrent
dynamic-worker invocations per request; when a model batched 5+ `code` calls
in one turn under Flue's parallel tool execution, the surplus calls failed
with `Too many concurrent dynamic workers`. The adapter now queues executions
above a cap of 3.

```diff
--- a/src/sandboxes/cloudflare-shell.ts
+++ b/src/sandboxes/cloudflare-shell.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: sandbox/cloudflare-shell@1
+// flue-blueprint: sandbox/cloudflare-shell@2
@@ -238,6 +238,29 @@ const CodeParams = {
 	required: ['code'],
 };

+// Cloudflare allows at most 4 concurrent dynamic-worker invocations per
+// request. A turn that batches more `code` calls than that would fail the
+// surplus with "Too many concurrent dynamic workers" — queue them above a
+// cap of 3 instead (headroom for anything else in the request that holds a
+// dynamic worker).
+const MAX_CONCURRENT_CODE_EXECUTIONS = 3;
+let activeCodeExecutions = 0;
+const codeExecutionWaiters: Array<() => void> = [];
+
+async function withCodeExecutionSlot<T>(run: () => Promise<T>): Promise<T> {
+	while (activeCodeExecutions >= MAX_CONCURRENT_CODE_EXECUTIONS) {
+		await new Promise<void>((resolve) => codeExecutionWaiters.push(resolve));
+	}
+	activeCodeExecutions++;
+	try {
+		return await run();
+	} finally {
+		activeCodeExecutions--;
+		codeExecutionWaiters.shift()?.();
+	}
+}
+
 function createCodeTool(
 	executor: DynamicWorkerExecutor,
 	stateProvider: ResolvedProvider,
@@ -252,7 +275,9 @@ function createCodeTool(
 		) {
 			const code = (params as { code: string }).code;
-			const { result, error, logs } = await executor.execute(code, [stateProvider]);
+			const { result, error, logs } = await withCodeExecutionSlot(() =>
+				executor.execute(code, [stateProvider]),
+			);
 			if (error) {
```

### Version 3 — 2026-07-16

Model-facing guidance only — no behavior change. The `code` tool's
description and the `code` parameter description were rewritten from
production failure data (a heavy consumer's Sentry classification of ~2,700
code-tool warnings): each new rule pre-empts an observed misuse bucket —
inventing nested `state` namespaces, calling other agent tools from inside
the snippet, using Node `require()`/`process`/`Buffer`, guessing file paths
instead of listing directories, bursting parallel `code` calls instead of
batching with `Promise.all`, and emitting TypeScript or undeclared
identifiers. To upgrade, replace the `CodeParams` `code` description string
and the `buildCodeToolDescription()` body with the current blueprint's
versions.

```diff
--- a/src/sandboxes/cloudflare-shell.ts
+++ b/src/sandboxes/cloudflare-shell.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: sandbox/cloudflare-shell@2
+// flue-blueprint: sandbox/cloudflare-shell@3
@@ const CodeParams = {
 		code: {
 			type: 'string',
 			description:
-				'A single async arrow function with the signature `async () => { ... return result; }`. ' +
-				'Inside the body, call `state.*` to operate on the workspace (see the type declarations ' +
-				'below). The function executes in an isolated Worker — no network, no DOM, no imports. ' +
-				'Return whatever JSON-serializable value you want back; it is returned as the tool result.',
+				'A string containing one self-contained async arrow function, for example ' +
+				"`async () => await state.readFile('/notes.md')`. Must be plain JavaScript " +
+				'(no TypeScript annotations). Only the `state` object is in scope — no other ' +
+				'tools, no Node.js APIs, no imports. Batch multiple operations with Promise.all ' +
+				'inside one function instead of issuing parallel code calls. Return a ' +
+				'JSON-serializable value; it is returned as the tool result.',
 		},
@@ function buildCodeToolDescription(): string {
+// Each rule below pre-empts an observed model failure bucket from production
+// use (Sentry, 2026-06/07): nested `state` shapes, native agent tools invoked
+// inside `code`, Node require()/API usage, guessed file paths, parallel
+// code-call bursts, and generated-JavaScript syntax/identifier defects.
 function buildCodeToolDescription(): string {
 	return [
-		'Run a snippet of JavaScript inside an isolated Worker against a durable',
-		'workspace filesystem. The snippet must be a single async arrow function:',
+		'Run one JavaScript snippet in an isolated Worker against the durable',
+		'workspace filesystem. The snippet must be a single, self-contained async',
+		'arrow function:',
 		'',
 		'  async () => {',
 		'    const text = await state.readFile("/notes.md");',
 		'    await state.writeFile("/notes.md", text.toUpperCase());',
 		'    return { bytes: text.length };',
 		'  }',
 		'',
-		'Rules:',
-		'- Write JavaScript, not TypeScript — no type annotations.',
-		'- Do not use `import` statements. Everything you need is on `state`.',
-		'- Always `return` the value you want back.',
+		'To touch several files, batch the work inside ONE call (Promise.all for',
+		'reads) instead of issuing parallel code calls:',
+		'',
+		'  async () => {',
+		'    const [a, b] = await Promise.all([',
+		'      state.readFile("/docs/a.md"),',
+		'      state.readFile("/docs/b.md"),',
+		'    ]);',
+		'    return { a, b };',
+		'  }',
+		'',
+		'Rules — each violation fails the call:',
+		'- `state` is the ONLY global beyond standard JavaScript built-ins. It is a',
+		'  flat object of async functions (declaration below); there is no state.fs,',
+		'  state.workspace, or any other nested namespace.',
+		'- Your other agent tools (read, write, edit, task, ...) DO NOT exist inside',
+		'  this snippet. Call them as separate direct tool calls, never from code.',
+		'- This is an isolated Worker, not Node.js: require(), import, fs, path,',
+		'  process, and Buffer do not exist. Network access (fetch, connect) is',
+		'  disabled — do not attempt outbound HTTP.',
+		'- Only use paths you have seen — from earlier reads or state.readdir().',
+		'  Never guess or construct a path from an ID or a name.',
+		'- Write plain JavaScript (no TypeScript annotations) and declare every',
+		'  variable you use. Keep the body simple; do analysis in your reply, not',
+		'  in code.',
+		'- Always `return` the value you want back; it must be JSON-serializable.',
 		'- For multi-file refactors, prefer `state.planEdits()` + `state.applyEditPlan()` over many writes.',
 		'- For tree-wide search/replace, use `state.replaceInFiles()` (transactional by default).',
-		'- Network access (`fetch`, `connect`) is disabled. Do not attempt outbound HTTP.',
 		'',
 		'The `state` API (TypeScript declaration; the runtime is JavaScript):',
```
