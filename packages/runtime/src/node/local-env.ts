/**
 * Pure-Node `SessionEnv` backed by the host filesystem and `child_process`.
 *
 * Powers `init({ sandbox: 'local' })` on the Node target. No sandboxing,
 * no virtual filesystem, no just-bash — `exec` shells out via the user's
 * default shell, file methods call `node:fs/promises` directly.
 *
 * Use this when you're running flue inside an external sandbox (Daytona,
 * E2B, a container, a CI runner, etc.) and want flue itself to operate on
 * the host filesystem without an additional layer of isolation.
 */
import { exec as execCb } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { abortErrorFor } from '../abort.ts';
import type { FileStat, SessionEnv, ShellResult } from '../types.ts';

const execAsync = promisify(execCb);

export interface LocalSessionEnvOptions {
	/** Working directory. Defaults to `process.cwd()`. */
	cwd?: string;
}

export function createLocalSessionEnv(options: LocalSessionEnvOptions = {}): SessionEnv {
	const cwd = path.resolve(options.cwd ?? process.cwd());

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
					env: opts?.env ? { ...process.env, ...opts.env } : process.env,
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
