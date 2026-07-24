import {
	DynamicWorkerExecutor,
	type DynamicWorkerExecutorOptions,
	type ResolvedProvider,
	resolveProvider,
} from '@cloudflare/codemode';
import {
	type FsStat as CfFsStat,
	STATE_TYPES,
	Workspace,
	WorkspaceFileSystem,
} from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
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

export interface HydrateFromBucketOptions {
	prefix?: string;
}

export async function hydrateFromBucket(
	workspace: Workspace,
	bucket: R2Bucket,
	options?: HydrateFromBucketOptions,
): Promise<void> {
	const prefix = options?.prefix;
	let cursor: string | undefined;

	while (true) {
		const listing = await bucket.list({ prefix, cursor });
		for (const obj of listing.objects) {
			const relativeKey = stripPrefix(obj.key, prefix);
			if (relativeKey === '' || relativeKey.endsWith('/')) continue;
			const body = await bucket.get(obj.key);
			if (!body) continue;
			await workspace.writeFileBytes(
				absolutize(relativeKey),
				new Uint8Array(await body.arrayBuffer()),
			);
		}

		if (!listing.truncated) break;
		if (!listing.cursor) {
			throw new Error('[flue] R2 listing was truncated but did not include a cursor.');
		}
		cursor = listing.cursor;
	}
}

function stripPrefix(key: string, prefix: string | undefined): string {
	if (!prefix) return key;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function absolutize(key: string): string {
	return key.startsWith('/') ? key : `/${key}`;
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
				} catch {}
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

// Raw JSON Schema: adapter tools feed the agent loop directly, which
// accepts plain JSON Schema parameter documents.
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

function createCodeTool(executor: DynamicWorkerExecutor, stateProvider: ResolvedProvider) {
	return {
		name: 'code',
		label: 'Run Code',
		description: buildCodeToolDescription(),
		parameters: CodeParams,
		async execute(_toolCallId: string, params: unknown) {
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
