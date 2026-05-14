/**
 * Pure-Node `SessionEnv` backed by the host filesystem and `child_process`.
 *
 * Internal implementation behind the `local()` sandbox factory (see
 * `./local.ts`). Not exported from `@flue/runtime/node` — user code reaches
 * this through `local(...)`. `exec` shells out via `child_process.exec`;
 * file methods call `node:fs/promises` directly.
 */
import { exec as execCb } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { abortErrorFor } from '../abort.ts';
import type { FileStat, SessionEnv, ShellResult } from '../types.ts';

const execAsync = promisify(execCb);

/**
 * Shell-essential env vars inherited from `process.env` by default. Pulled
 * once at sandbox construction.
 *
 * Invariant: nothing on this list should be sensitive on a typical host.
 * Adding entries here is a security-relevant decision — secrets, tokens,
 * cloud-provider creds, and agent sockets MUST NOT appear. To expose
 * anything else, callers opt in explicitly via `options.env`.
 */
export const DEFAULT_LOCAL_ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'HOSTNAME',
	'SHELL',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TZ',
	'TERM',
	'TMPDIR',
	'TMP',
	'TEMP',
] as const;

export interface LocalSessionEnvOptions {
	/** Working directory. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Env vars layered on top of `DEFAULT_LOCAL_ENV_ALLOWLIST`. Set a key
	 * to `undefined` to drop a default. Per-call `opts.env` on `exec()`
	 * layers on top of this.
	 *
	 * Pass-through is intentionally explicit:
	 *
	 * ```ts
	 * // Expose one host var.
	 * local({ env: { GH_TOKEN: process.env.GH_TOKEN } });
	 *
	 * // Inherit everything (exposes host secrets to the model's bash tool).
	 * local({ env: { ...process.env } });
	 * ```
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Snapshot `process.env` through the allowlist, then layer user overrides.
 * Called once per sandbox; the result is captured in a closure and reused
 * across every `exec()` so per-call cost stays minimal and the env shape
 * is stable for the sandbox's lifetime (host mutations to `process.env`
 * after construction are NOT picked up).
 */
function resolveBaseEnv(userEnv: LocalSessionEnvOptions['env']): NodeJS.ProcessEnv {
	// Reject non-record shapes (notably `true` and arrays) at runtime so
	// we keep the option's shape open for future shorthands like
	// `env: true` meaning "pass through all of process.env". The TS type
	// already forbids these; this guard is for JS callers and accidental
	// `any`s.
	if (userEnv !== undefined && (typeof userEnv !== 'object' || Array.isArray(userEnv))) {
		throw new TypeError(
			'[flue] local() `env` must be a Record<string, string | undefined>. ' +
				'To inherit the full host env, pass `env: { ...process.env }`.',
		);
	}

	const base: NodeJS.ProcessEnv = {};
	for (const key of DEFAULT_LOCAL_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) base[key] = value;
	}
	if (!userEnv) return base;
	for (const [key, value] of Object.entries(userEnv)) {
		if (value === undefined) {
			delete base[key];
		} else {
			base[key] = value;
		}
	}
	return base;
}

export function createLocalSessionEnv(options: LocalSessionEnvOptions = {}): SessionEnv {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const baseEnv = resolveBaseEnv(options.env);

	const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

	return {
		async exec(
			command,
			opts,
		): Promise<ShellResult> {
			const signal = opts?.signal;
			if (signal?.aborted) throw abortErrorFor(signal);

			// Compose timeout (seconds) with the caller's signal so signal-blind
			// callers still observe deadlines and signal-aware ones can abort
			// mid-flight. Mirrors the bashFactory adapter's behavior.
			const timeoutSignal =
				typeof opts?.timeout === 'number'
					? AbortSignal.timeout(opts.timeout * 1000)
					: undefined;
			const mergedSignal =
				signal && timeoutSignal
					? AbortSignal.any([signal, timeoutSignal])
					: (signal ?? timeoutSignal);

			try {
				const { stdout, stderr } = await execAsync(command, {
					cwd: opts?.cwd ? resolvePath(opts.cwd) : cwd,
					// Per-call env layers on top of `baseEnv` (allowlist +
					// sandbox `env` option). `process.env` is intentionally
					// never read here.
					env: opts?.env ? { ...baseEnv, ...opts.env } : baseEnv,
					signal: mergedSignal,
					// Return strings (not Buffers) and lift the default 1MB cap.
					encoding: 'utf8',
					maxBuffer: 64 * 1024 * 1024,
				});
				if (signal?.aborted) throw abortErrorFor(signal);
				return { stdout, stderr, exitCode: 0 };
			} catch (err: any) {
				if (signal?.aborted) throw abortErrorFor(signal);
				// `child_process.exec` rejects on non-zero exit. Surface stdout/stderr
				// and the exit code through the standard ShellResult shape rather than
				// as an exception — matches just-bash and remote sandbox connectors.
				if (err && typeof err === 'object' && 'code' in err) {
					return {
						stdout: typeof err.stdout === 'string' ? err.stdout : '',
						stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message ?? ''),
						exitCode: typeof err.code === 'number' ? err.code : 1,
					};
				}
				throw err;
			}
		},

		async readFile(p) {
			return fs.readFile(resolvePath(p), 'utf8');
		},

		async readFileBuffer(p) {
			const buf = await fs.readFile(resolvePath(p));
			// Return a fresh Uint8Array view; Node Buffers are subclasses but
			// downstream code shouldn't rely on Buffer-only methods.
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		},

		async writeFile(p, content) {
			const resolved = resolvePath(p);
			// Auto-create parent directory, matching the BashFactory adapter's
			// behavior so users get consistent semantics across sandbox modes.
			const dir = path.dirname(resolved);
			if (dir && dir !== resolved) {
				await fs.mkdir(dir, { recursive: true });
			}
			await fs.writeFile(resolved, content);
		},

		async stat(p): Promise<FileStat> {
			const s = await fs.stat(resolvePath(p));
			return {
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
				isSymbolicLink: s.isSymbolicLink(),
				size: s.size,
				mtime: s.mtime,
			};
		},

		async readdir(p) {
			return fs.readdir(resolvePath(p));
		},

		async exists(p) {
			try {
				await fs.access(resolvePath(p));
				return true;
			} catch {
				return false;
			}
		},

		async mkdir(p, opts) {
			await fs.mkdir(resolvePath(p), { recursive: opts?.recursive ?? false });
		},

		async rm(p, opts) {
			await fs.rm(resolvePath(p), {
				recursive: opts?.recursive ?? false,
				force: opts?.force ?? false,
			});
		},

		cwd,
		resolvePath,
	};
}
