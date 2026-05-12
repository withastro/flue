/**
 * Sandbox adapters: wraps BashFactory or SandboxApi into SessionEnv.
 */
import type {
	BashFactory,
	BashLike,
	FileStat,
	FlueFs,
	SessionEnv,
	ShellResult,
} from './types.ts';
import { abortErrorFor } from './abort.ts';
import { normalizePath } from './session.ts';
export type { SandboxFactory, SessionEnv, FileStat } from './types.ts';

/** Adapt a SessionEnv to the public FlueFs surface. */
export function createFlueFs(env: SessionEnv): FlueFs {
	return {
		readFile: (path) => env.readFile(path),
		readFileBuffer: (path) => env.readFileBuffer(path),
		writeFile: (path, content) => env.writeFile(path, content),
		stat: (path) => env.stat(path),
		readdir: (path) => env.readdir(path),
		exists: (path) => env.exists(path),
		mkdir: (path, options) => env.mkdir(path, options),
		rm: (path, options) => env.rm(path, options),
	};
}

export function createCwdSessionEnv(parentEnv: SessionEnv, cwd: string): SessionEnv {
	const scopedCwd = normalizePath(cwd);
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (scopedCwd === '/') return normalizePath('/' + p);
		return normalizePath(scopedCwd + '/' + p);
	};

	return {
		exec: (cmd, opts) =>
			parentEnv.exec(cmd, {
				cwd: opts?.cwd ?? scopedCwd,
				env: opts?.env,
				timeout: opts?.timeout,
				signal: opts?.signal,
			}),
		readFile: (p) => parentEnv.readFile(resolvePath(p)),
		readFileBuffer: (p) => parentEnv.readFileBuffer(resolvePath(p)),
		writeFile: (p, c) => parentEnv.writeFile(resolvePath(p), c),
		stat: (p) => parentEnv.stat(resolvePath(p)),
		readdir: (p) => parentEnv.readdir(resolvePath(p)),
		exists: (p) => parentEnv.exists(resolvePath(p)),
		mkdir: (p, o) => parentEnv.mkdir(resolvePath(p), o),
		rm: (p, o) => parentEnv.rm(resolvePath(p), o),
		cwd: scopedCwd,
		resolvePath,
	};
}

export async function bashFactoryToSessionEnv(factory: BashFactory): Promise<SessionEnv> {
	const bash = await factory();
	assertBashLike(bash);
	return createBashSessionEnv(bash);
}

function createBashSessionEnv(bash: BashLike): SessionEnv {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p: string) => (p.startsWith('/') ? p : fs.resolvePath(cwd, p));

	return {
		exec: async (cmd, opts) => {
			const exec = bash.exec as unknown as (
				this: BashLike,
				command: string,
				options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
			) => Promise<ShellResult>;

			// Just-bash has no native timeout option. Translate `timeout`
			// into an AbortSignal and compose with the caller's signal so
			// bash factories observe deadlines with the same fidelity as
			// signal-aware sandbox connectors.
			const timeoutSignal =
				typeof opts?.timeout === 'number'
					? AbortSignal.timeout(opts.timeout * 1000)
					: undefined;
			const mergedSignal =
				opts?.signal && timeoutSignal
					? AbortSignal.any([opts.signal, timeoutSignal])
					: (opts?.signal ?? timeoutSignal);

			const result = await exec.call(
				bash,
				cmd,
				opts ? { cwd: opts.cwd, env: opts.env, signal: mergedSignal } : undefined,
			);
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);
			return result;
		},
		readFile: (p) => fs.readFile(resolve(p)),
		readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
		writeFile: async (p, content) => {
			const resolved = resolve(p);
			const dir = resolved.replace(/\/[^/]*$/, '');
			if (dir && dir !== resolved) {
				try {
					await fs.mkdir(dir, { recursive: true });
				} catch {
					/* parent already exists */
				}
			}
			await fs.writeFile(resolved, content);
		},
		stat: (p) => fs.stat(resolve(p)),
		readdir: (p) => fs.readdir(resolve(p)),
		exists: (p) => fs.exists(resolve(p)),
		mkdir: (p, o) => fs.mkdir(resolve(p), o),
		rm: (p, o) => fs.rm(resolve(p), o),
		cwd,
		resolvePath: resolve,
	};
}

function assertBashLike(value: unknown): asserts value is BashLike {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('exec' in value) ||
		!('getCwd' in value) ||
		!('fs' in value) ||
		typeof (value as any).exec !== 'function' ||
		typeof (value as any).getCwd !== 'function' ||
		typeof (value as any).fs !== 'object'
	) {
		throw new Error('[flue] BashFactory must return a Bash-like object.');
	}
}

/**
 * Interface that remote sandbox providers must implement.
 *
 * `exec()` cancellation is expressed two ways. Connectors should honor at
 * least one — preferably `timeout`, since most provider SDKs expose a
 * native timeout option but few support mid-flight cancellation:
 *
 *   - `timeout?: number` (seconds): the **primary** cancellation contract.
 *     Forward to the provider's native timeout option (E2B `timeoutMs`,
 *     Daytona `timeout`, Modal `timeout`, etc.). Required for parity with
 *     the LLM bash tool, which always passes a `timeout` hint when the
 *     model requests one.
 *   - `signal?: AbortSignal` (optional): for connectors whose SDK supports
 *     mid-flight cancellation (Mirage's executor, in-process bash). Lets
 *     SDK callers do ad-hoc `abort()`. Connectors that can't honor it
 *     should ignore it; the deadline is still enforced via `timeout`.
 *
 * Connectors that support both should observe whichever fires first.
 */
export interface SandboxApi {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;
}

/** Wrap a SandboxApi into SessionEnv. No just-bash, no intermediate filesystem layer. */
export function createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv {
	const resolvePath = (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (cwd === '/') return normalizePath('/' + p);
		return normalizePath(cwd + '/' + p);
	};

	return {
		async exec(
			command: string,
			options?: {
				cwd?: string;
				env?: Record<string, string>;
				timeout?: number;
				signal?: AbortSignal;
			},
		): Promise<ShellResult> {
			// Pre/post abort checks here — not in every connector. Most
			// provider SDKs (E2B, Daytona, Modal, Boxd, etc.) don't accept
			// an AbortSignal, so a caller that aborts during a long-running
			// remote command would otherwise see the call return
			// successfully and the abort silently dropped. Centralizing the
			// check means connectors only need to wire `signal` into their
			// SDK when one supports it (Mirage, Vercel); the rest get
			// correct abort semantics for free.
			const signal = options?.signal;
			if (signal?.aborted) throw abortErrorFor(signal);
			const result = await api.exec(command, {
				cwd: options?.cwd ?? cwd,
				env: options?.env,
				timeout: options?.timeout,
				signal,
			});
			if (signal?.aborted) throw abortErrorFor(signal);
			return result;
		},

		async readFile(path: string): Promise<string> {
			return api.readFile(resolvePath(path));
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			return api.readFileBuffer(resolvePath(path));
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			return api.writeFile(resolvePath(path), content);
		},

		async stat(path: string): Promise<FileStat> {
			return api.stat(resolvePath(path));
		},

		async readdir(path: string): Promise<string[]> {
			return api.readdir(resolvePath(path));
		},

		async exists(path: string): Promise<boolean> {
			return api.exists(resolvePath(path));
		},

		async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
			return api.mkdir(resolvePath(path), options);
		},

		async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
			return api.rm(resolvePath(path), options);
		},

		cwd,

		resolvePath,
	};
}
