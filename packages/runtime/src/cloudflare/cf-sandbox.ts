/** Wraps a @cloudflare/sandbox instance (from getSandbox()) into SessionEnv. */
import { abortErrorFor } from '../abort.ts';
import { decodeBase64, encodeBase64 } from '../base64.ts';
import { SandboxDiedError } from '../errors.ts';
import type { SandboxApi } from '../sandbox.ts';
import { createSandboxSessionEnv } from '../sandbox.ts';
import type { SandboxFactory, SessionEnv } from '../types.ts';

/**
 * Minimal structural surface of a `@cloudflare/sandbox` Durable Object stub
 * (the value returned by `getSandbox()`). Kept structural so `@flue/runtime`
 * does not depend on `@cloudflare/sandbox` and stays importable on Node;
 * only the methods Flue calls are listed. A wrong object fails loudly on
 * the first method call.
 */
export interface CloudflareSandboxStub {
	exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
		},
	): Promise<{ success: boolean; stdout: string; stderr: string; exitCode?: number }>;
	readFile(path: string, options?: { encoding?: string }): Promise<{ content: string }>;
	writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
	exists(path: string): Promise<{ exists: boolean }>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	deleteFile(path: string): Promise<unknown>;
	/**
	 * Container lifecycle state, read from Durable Object storage without a
	 * container round trip. The death detector polls it while a call is
	 * pending; `status` becomes `'stopped'` or `'stopped_with_code'` once the
	 * container exits.
	 */
	getState(): Promise<{ status: string }>;
}

export interface CloudflareSandboxOptions {
	/** Working directory inside the container. Defaults to `/workspace`. */
	cwd?: string;
}

/**
 * Wrap a Cloudflare Sandbox Durable Object stub into a Flue
 * {@link SandboxFactory}:
 *
 * ```ts
 * import { getSandbox } from '@cloudflare/sandbox';
 * import { env } from 'cloudflare:workers';
 * import { cloudflareSandbox } from '@flue/runtime/cloudflare';
 *
 * export function MyAgent({ id }: AgentProps) {
 *   useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)));
 *   return '…';
 * }
 * ```
 */
export function cloudflareSandbox(
	sandbox: CloudflareSandboxStub,
	options?: CloudflareSandboxOptions,
): SandboxFactory {
	return {
		createSessionEnv: async () => cfSandboxToSessionEnv(sandbox, options?.cwd),
	};
}

/** Single-quote a path for the container shell; embedded quotes become `'\''`. */
function shellQuote(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/** How often the death detector reads container state while a call is pending. */
const CONTAINER_STATE_POLL_MS = 5_000;
/** How long a state probe may go unanswered before the container is presumed dead. */
const CONTAINER_PROBE_SILENCE_MS = 10_000;

interface DeathDetectorCadence {
	statePollMs: number;
	probeSilenceMs: number;
}

let cadence: DeathDetectorCadence = {
	statePollMs: CONTAINER_STATE_POLL_MS,
	probeSilenceMs: CONTAINER_PROBE_SILENCE_MS,
};

/**
 * Test seam: shrink the death-detector cadence so suites can drive the poller
 * with real timers in milliseconds. Call with no argument to restore the
 * production constants. Deliberately absent from the cloudflare barrel — the
 * cadence is not a public option.
 */
export function setContainerDeathCadenceForTests(override?: DeathDetectorCadence): void {
	cadence = override ?? {
		statePollMs: CONTAINER_STATE_POLL_MS,
		probeSilenceMs: CONTAINER_PROBE_SILENCE_MS,
	};
}

/**
 * Await a sandbox call while watching for container death. The Cloudflare
 * Sandbox transport leaves in-flight calls pending forever when the container
 * dies, so a bare await can hang an agent indefinitely. While the call is
 * pending, this polls `getState()` (a Durable Object storage read, no
 * container round trip) and rejects with {@link SandboxDiedError} once the
 * container reports stopped; a probe that itself goes unanswered for the
 * silence bound means the Durable Object is unreachable too, and the
 * container is presumed dead with it.
 *
 * There is deliberately no deadline: any status other than `'stopped'` /
 * `'stopped_with_code'` — including transitional ones like `'stopping'` and
 * unrecognized future values — counts as alive, so a legitimately slow
 * command on a healthy container is never interrupted. When `signal` is
 * provided, its abort joins the race and rejects immediately even though the
 * underlying call cannot be cancelled remotely.
 */
function raceContainerDeath<T>(
	sandbox: CloudflareSandboxStub,
	operation: string,
	rpc: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		// The call is already in flight; swallow its eventual settlement so the
		// early rejection can't leave an unhandled rejection behind.
		rpc.catch(() => {});
		return Promise.reject(abortErrorFor(signal));
	}
	const { statePollMs, probeSilenceMs } = cadence;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let silenceTimer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener = (): void => {};

		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(silenceTimer);
			removeAbortListener();
			complete();
		};

		if (signal) {
			const onAbort = (): void => settle(() => reject(abortErrorFor(signal)));
			signal.addEventListener('abort', onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener('abort', onAbort);
		}

		const probe = (): void => {
			silenceTimer = setTimeout(() => {
				settle(() => reject(new SandboxDiedError({ operation, reason: 'probe_silent' })));
			}, probeSilenceMs);
			sandbox.getState().then(
				({ status }) => {
					if (settled) return;
					clearTimeout(silenceTimer);
					if (status === 'stopped' || status === 'stopped_with_code') {
						settle(() => reject(new SandboxDiedError({ operation, reason: 'stopped' })));
					} else {
						pollTimer = setTimeout(probe, statePollMs);
					}
				},
				() => {
					// A rejecting probe is an answer, not silence — and not proof
					// of death. Keep polling.
					if (settled) return;
					clearTimeout(silenceTimer);
					pollTimer = setTimeout(probe, statePollMs);
				},
			);
		};
		pollTimer = setTimeout(probe, statePollMs);

		// These handlers double as the losing branch's rejection consumer, so a
		// late settlement after death or abort can't surface as an unhandled
		// rejection.
		rpc.then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

// Module-private: only cloudflareSandbox() above uses it, and the entry-point
// tests assert it stays off the cloudflare and internal barrels.
function cfSandboxToSessionEnv(
	sandbox: CloudflareSandboxStub,
	cwd: string = '/workspace',
): SessionEnv {
	// Every container call goes through the death detector so a call that is
	// in flight when the container dies settles instead of hanging forever.
	const guarded = <T>(operation: string, rpc: Promise<T>, signal?: AbortSignal): Promise<T> =>
		raceContainerDeath(sandbox, operation, rpc, signal);

	const api: SandboxApi = {
		async readFile(path: string): Promise<string> {
			const file = await guarded('readFile', sandbox.readFile(path));
			return file.content;
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			const file = await guarded('readFile', sandbox.readFile(path, { encoding: 'base64' }));
			return decodeBase64(file.content);
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			if (typeof content === 'string') {
				await guarded('writeFile', sandbox.writeFile(path, content));
			} else {
				await guarded(
					'writeFile',
					sandbox.writeFile(path, encodeBase64(content), { encoding: 'base64' }),
				);
			}
		},

		async stat(path: string) {
			const quoted = shellQuote(path);
			// `stat -L` follows symlinks so isFile/isDirectory/size/mtime match
			// fs.stat semantics on the node target; the second (non-following)
			// stat reports whether the path itself is a symlink.
			const result = await guarded(
				'stat',
				sandbox.exec(`stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`),
			);
			if (!result.success) {
				throw new Error(`stat failed for ${path}: ${result.stderr}`);
			}
			const [target = '', self = ''] = (result.stdout ?? '').trim().split('\n');
			const [size = '0', mtime = '0', type = ''] = target.split('/');
			return {
				isFile: type.includes('regular'),
				isDirectory: type === 'directory',
				isSymbolicLink: self.trim() === 'symbolic link',
				size: parseInt(size, 10),
				mtime: new Date(parseInt(mtime, 10) * 1000),
			};
		},

		async readdir(path: string): Promise<string[]> {
			// NUL-separated `find` includes dotfiles (unlike plain `ls`) and
			// survives filenames containing newlines.
			const result = await guarded(
				'readdir',
				sandbox.exec(`find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`),
			);
			if (!result.success) {
				throw new Error(`readdir failed for ${path}: ${result.stderr}`);
			}
			return result.stdout.split('\0').filter((s: string) => s.length > 0);
		},

		async exists(path: string): Promise<boolean> {
			const result = await guarded('exists', sandbox.exists(path));
			return result.exists;
		},

		async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
			await guarded('mkdir', sandbox.mkdir(path, opts));
		},

		async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
			if (!opts?.recursive && !opts?.force) {
				await guarded('rm', sandbox.deleteFile(path));
				return;
			}
			// The provider's delete API handles single files only, so flagged
			// removals run `rm` in the container. Shell semantics match node's
			// fs.rm: `-f` resolves on a missing path, `-r` without `-f` fails
			// on one, and `-f` on a directory still errors. `--` guards paths
			// beginning with a dash.
			const result = await guarded(
				'rm',
				sandbox.exec(
					`rm ${opts.force ? '-f ' : ''}${opts.recursive ? '-r ' : ''}-- ${shellQuote(path)}`,
				),
			);
			if (!result.success) {
				throw new Error(`rm failed for ${path}: ${result.stderr}`);
			}
		},

		async exec(
			command: string,
			execOpts?: {
				cwd?: string;
				env?: Record<string, string>;
				timeoutMs?: number;
				signal?: AbortSignal;
			},
		): Promise<{ stdout: string; stderr: string; exitCode: number }> {
			const externalSignal = execOpts?.signal;
			if (externalSignal?.aborted) throw abortErrorFor(externalSignal);

			// Cloudflare Sandbox does not currently accept AbortSignal across the
			// getSandbox(...).exec(...) RPC boundary. Keep cancellation local while
			// forwarding cloneable execution options to the sandbox: the signal
			// joins the death detector's race, so an abort rejects immediately
			// even though the container keeps running the command.
			const result = await guarded(
				'exec',
				sandbox.exec(command, {
					cwd: execOpts?.cwd,
					env: execOpts?.env,
					// The Cloudflare sandbox `timeout` option is in milliseconds.
					timeout: execOpts?.timeoutMs,
				}),
				externalSignal,
			);

			return {
				stdout: result.stdout ?? '',
				stderr: result.stderr ?? '',
				exitCode: result.exitCode ?? (result.success ? 0 : 1),
			};
		},
	};

	return createSandboxSessionEnv(api, cwd);
}
