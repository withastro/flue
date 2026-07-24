/**
 * Pure-Node `SessionEnv` backed by the host filesystem and `child_process`.
 *
 * Internal implementation behind the `local()` sandbox factory (see
 * `./local.ts`). Not exported from `@flue/runtime/node` — user code reaches
 * this through `local(...)`. `exec` shells out via `child_process.spawn`;
 * file methods call `node:fs/promises` directly.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { abortErrorFor, composeTimeoutSignal } from '../abort.ts';
import { writeFileCreatingParents } from '../sandbox.ts';
import type { FileStat, SessionEnv, ShellResult } from '../types.ts';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL when tearing down a process group. */
const KILL_GRACE_MS = 2000;

/**
 * Shell used for `exec()`. The model-facing tool is named `bash` and the
 * default virtual sandbox emulates bash, so prefer real bash over Node's
 * default `/bin/sh` — on hosts where sh is dash (Debian/Ubuntu CI images)
 * bashisms like `[[ ]]` and `set -o pipefail` would otherwise fail with
 * syntax errors the model can't explain. Falls back to the platform default
 * shell when bash is absent (minimal images, Windows). Probed once per
 * process, lazily on first exec.
 *
 * The probe resolves an absolute path (using the host `process.env` PATH)
 * so exec() never depends on the sandbox env's PATH to find its own shell —
 * `/bin/sh` was absolute, and a sandbox with an overridden PATH must still
 * be able to run commands.
 */
let resolvedShell: string | true | undefined;
function resolveShell(): string | true {
	if (resolvedShell === undefined) {
		if (process.platform === 'win32') {
			resolvedShell = true;
		} else {
			const probe = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
			const found = probe.status === 0 ? probe.stdout.trim() : '';
			resolvedShell = found.startsWith('/') ? found : true;
		}
	}
	return resolvedShell;
}

/**
 * Run `command` through the shell from `resolveShell()` in its own process group and
 * collect output. On abort (caller signal or timeout) the entire group is
 * signalled (SIGTERM, escalating to SIGKILL) so compound commands can't
 * orphan grandchildren on the host — `child_process.exec`'s `signal` option
 * kills only the shell itself, leaving e.g. backgrounded dev servers alive.
 *
 * Always resolves with a `ShellResult`; spawn failures surface as
 * `exitCode: 1` with the error message on stderr, matching the previous
 * `exec`-based behavior for non-zero exits.
 */
function execShell(
	command: string,
	opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ShellResult> {
	return new Promise((resolve) => {
		const child = spawn(command, {
			cwd: opts.cwd,
			env: opts.env,
			shell: resolveShell(),
			// POSIX: lead a new process group so abort can signal the whole
			// tree via `process.kill(-pid)`. No-op grouping on Windows.
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let truncated = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;

		const killTree = (sig: NodeJS.Signals): void => {
			if (child.pid === undefined) return;
			try {
				// Negative pid → signal the process group (POSIX).
				process.kill(-child.pid, sig);
			} catch {
				try {
					child.kill(sig);
				} catch {
					// Already gone.
				}
			}
		};

		const onAbort = (): void => {
			killTree('SIGTERM');
			killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
			killTimer.unref();
		};

		const settle = (result: ShellResult): void => {
			if (settled) return;
			settled = true;
			if (killTimer !== undefined) clearTimeout(killTimer);
			opts.signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};

		if (opts.signal?.aborted) {
			onAbort();
		} else {
			opts.signal?.addEventListener('abort', onAbort, { once: true });
		}

		const onData = (chunk: string, target: 'stdout' | 'stderr'): void => {
			if (target === 'stdout') stdout += chunk;
			else stderr += chunk;
			if (!truncated && stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
				truncated = true;
				killTree('SIGTERM');
			}
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => onData(chunk, 'stdout'));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => onData(chunk, 'stderr'));

		child.once('error', (err) => {
			// Spawn failure (no 'close' will follow) or post-spawn kill error.
			killTree('SIGTERM');
			settle({ stdout, stderr: stderr || String(err.message ?? err), exitCode: 1 });
		});

		child.once('close', (code) => {
			if (truncated) {
				settle({
					stdout,
					stderr: `${stderr}\n[flue] local exec output exceeded ${MAX_OUTPUT_BYTES} bytes; process tree killed`,
					exitCode: 1,
				});
				return;
			}
			// `code` is null when the child died from a signal (abort/timeout).
			settle({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

/**
 * Shell-essential env vars inherited from `process.env` by default. Pulled
 * once at sandbox construction.
 *
 * Invariant: nothing on this list should be sensitive on a typical host.
 * Adding entries here is a security-relevant decision — secrets, tokens,
 * cloud-provider creds, and agent sockets MUST NOT appear. To expose
 * anything else, callers opt in explicitly via `options.env`.
 */
const DEFAULT_LOCAL_ENV_ALLOWLIST = [
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
		async exec(command, opts): Promise<ShellResult> {
			const signal = opts?.signal;
			if (signal?.aborted) throw abortErrorFor(signal);

			// Compose timeoutMs with the caller's signal so signal-blind
			// callers still observe deadlines and signal-aware ones can abort
			// mid-flight. Mirrors the bashFactory adapter's behavior.
			const { mergedSignal } = composeTimeoutSignal(opts?.timeoutMs, signal);

			const result = await execShell(command, {
				cwd: opts?.cwd ? resolvePath(opts.cwd) : cwd,
				// Per-call env layers on top of `baseEnv` (allowlist +
				// sandbox `env` option). `process.env` is intentionally
				// never read here.
				env: opts?.env ? { ...baseEnv, ...opts.env } : baseEnv,
				signal: mergedSignal,
			});
			if (signal?.aborted) throw abortErrorFor(signal);
			return result;
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
			// FlueFs.writeFile guarantees parents are created as needed in
			// every sandbox mode; the shared lazy implementation keeps the
			// happy path at a single fs call.
			await writeFileCreatingParents(
				() => fs.writeFile(resolved, content),
				() => fs.mkdir(path.dirname(resolved), { recursive: true }),
			);
		},

		async stat(p): Promise<FileStat> {
			const resolved = resolvePath(p);
			// fs.stat follows symlinks, so its Stats.isSymbolicLink() is always
			// false. lstat the path itself for the symlink flag, then follow the
			// link for type/size/mtime so they describe the target (matching
			// cf-sandbox's `stat -L` semantics).
			const l = await fs.lstat(resolved);
			const s = l.isSymbolicLink() ? await fs.stat(resolved) : l;
			return {
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
				isSymbolicLink: l.isSymbolicLink(),
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
