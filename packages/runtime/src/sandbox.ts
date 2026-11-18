/**
 * Sandbox adapters: wraps BashFactory or SandboxDriver into a live Sandbox.
 */

import { abortErrorFor, composeTimeoutSignal } from './abort.ts';
import type {
	BashFactory,
	BashLike,
	FileStat,
	Sandbox,
	SandboxFactory,
	ShellResult,
} from './types.ts';

export type { Sandbox } from './types.ts';

/**
 * Settlement report for an orphaned command: an `exec` whose caller was
 * released by an abort while the provider call was still in flight. The
 * runtime's `Sandbox` wrappers reject promptly on abort — never gated on
 * the remote command's settlement — so on a provider that cannot cancel
 * mid-flight, the command keeps running until it settles on its own. That
 * settlement is consumed (fulfillment and rejection alike — a late
 * `SandboxDiedError` lands on `error` instead of surfacing anywhere) and is
 * never recorded into the conversation; the `onOrphanSettled` callback on
 * {@link sandboxFromDriver} is its only outlet, for adapters that want
 * to log, bill, or reap the orphan out-of-band.
 */
export interface OrphanedExecSettlement {
	/** The command that was orphaned. */
	command: string;
	/** When the provider call started. */
	startedAt: Date;
	/** When the caller's abort released the awaiting fiber. */
	abortedAt: Date;
	/** When the orphaned provider call finally settled. */
	settledAt: Date;
	/** The orphan's result, when it fulfilled. */
	result?: ShellResult;
	/** The orphan's rejection reason, when it rejected (e.g. a late `SandboxDiedError`). */
	error?: unknown;
}

/** A contained failure from an observational sandbox callback. */
export interface SandboxObserverFailure {
	observer: 'onOutput' | 'onOrphanSettled';
	error: unknown;
}

/**
 * Keep observational callbacks outside command control flow while making their
 * failures visible to the adapter. A broken failure reporter is contained too;
 * there is no callback left to notify, so that last failure goes to stderr.
 */
function invokeSandboxObserver(
	observer: SandboxObserverFailure['observer'],
	callback: () => unknown,
	onObserverError?: (failure: SandboxObserverFailure) => void,
): void {
	const reportFailureReporterError = (
		reportError: unknown,
		failure: SandboxObserverFailure,
	): void => {
		console.error(
			'[flue:sandbox] observer failure reporter failed:',
			reportError,
			'Original observer failure:',
			failure,
		);
	};
	const report = (error: unknown): void => {
		const failure = { observer, error } as const;
		if (!onObserverError) {
			console.error(`[flue:sandbox] ${observer} callback failed:`, error);
			return;
		}
		try {
			const result = onObserverError(failure);
			if (isThenable(result)) {
				void Promise.resolve(result).catch((reportError: unknown) =>
					reportFailureReporterError(reportError, failure),
				);
			}
		} catch (reportError) {
			reportFailureReporterError(reportError, failure);
		}
	};

	try {
		const result = callback();
		if (isThenable(result)) void Promise.resolve(result).catch(report);
	} catch (error) {
		report(error);
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === 'object' && value !== null) || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

/**
 * Appended to the abort reason on a mid-flight rejection. Uniformly
 * pessimistic: even a cancel-capable provider has not confirmed the kill at
 * rejection time, and the message reaches the model verbatim through the
 * error tool result.
 */
const ORPHANED_EXEC_SUFFIX =
	' The sandbox command could not be confirmed cancelled and may still be running.';

/**
 * The `Sandbox.exec` abort race, implemented once for every wrapper-built
 * adapter: when `signal` aborts mid-flight, reject promptly with an
 * `AbortError` — never gated on the provider promise, which most sandbox
 * SDKs cannot cancel. The provider promise becomes an orphan whose
 * fulfillment AND rejection are consumed here (load-bearing on workerd,
 * where an unhandled rejection is an exception) and reported only to
 * `onOrphanSettled`.
 *
 * A pre-aborted signal rejects before `run()` is invoked, so the command
 * never executes; without a signal this is a plain await of `run()`.
 */
function raceExecAbort(
	command: string,
	run: () => Promise<ShellResult>,
	signal: AbortSignal | undefined,
	onOrphanSettled?: (settlement: OrphanedExecSettlement) => void,
	onObserverError?: (failure: SandboxObserverFailure) => void,
): Promise<ShellResult> {
	if (signal?.aborted) return Promise.reject(abortErrorFor(signal));
	if (!signal) return run();

	const startedAt = new Date();
	let pending: Promise<ShellResult>;
	try {
		pending = run();
	} catch (error) {
		return Promise.reject(error);
	}

	return new Promise<ShellResult>((resolve, reject) => {
		let settled = false;

		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			const abortedAt = new Date();
			// The provider promise is now an orphan. Consume both settlement
			// paths so nothing can surface as an unhandled rejection, and hand
			// the settlement to the adapter's observer — its only outlet: the
			// conversation already recorded the terminal story at abort time,
			// and a post-hoc second outcome would violate reducer invariants.
			const record = (outcome: { result: ShellResult } | { error: unknown }): void => {
				if (!onOrphanSettled) return;
				invokeSandboxObserver(
					'onOrphanSettled',
					() =>
						onOrphanSettled({
							command,
							startedAt,
							abortedAt,
							settledAt: new Date(),
							...outcome,
						}),
					onObserverError,
				);
			};
			pending.then(
				(result) => record({ result }),
				(error: unknown) => record({ error }),
			);
			const base = abortErrorFor(signal);
			const error = new DOMException(base.message + ORPHANED_EXEC_SUFFIX, 'AbortError');
			// `cause` is read-only on DOMException in some runtimes.
			try {
				Object.defineProperty(error, 'cause', { value: signal.reason, configurable: true });
			} catch {
				/* leave cause unset */
			}
			reject(error);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}

		pending.then(
			(result) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				// An abort that lands in the same tick as completion still
				// rejects — no stale success.
				if (signal.aborted) reject(abortErrorFor(signal));
				else resolve(result);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Shared implementation of the `FlueFs.writeFile` parent-creation guarantee.
 * Every `Sandbox` adapter (local, bash factory, SandboxDriver wrapper) routes
 * writes through here so the cross-mode contract has exactly one
 * implementation.
 *
 * Lazy by design: try the write first so the happy path costs a single call
 * (no extra remote round-trip per write). When the write fails — most often a
 * missing parent directory — `mkdir -p` the parent and retry once. Mkdir
 * errors are ignored so that when the original failure was something else
 * entirely, the retry reproduces it and its error propagates unchanged.
 */
export async function writeFileCreatingParents(
	write: () => Promise<void>,
	mkdirParent: () => Promise<unknown>,
): Promise<void> {
	try {
		await write();
		return;
	} catch {
		// Fall through to parent creation + retry.
	}
	try {
		await mkdirParent();
	} catch {
		// Ignore: the retried write's error is the authoritative failure.
	}
	await write();
}

/** Parent directory of an absolute POSIX path (`/a/b.txt` → `/a`, `/a.txt` → `/`). */
function posixParentDir(p: string): string {
	return p.replace(/\/[^/]*$/, '') || '/';
}

/** Collapse `.`/`..`/empty segments of a POSIX path into a normalized absolute path. */
function normalizePath(p: string): string {
	const parts = p.split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			result.pop();
		} else {
			result.push(part);
		}
	}
	return `/${result.join('/')}`;
}

/** Resolve a possibly-relative POSIX path against `cwd`, normalizing the result. */
function makeResolvePath(cwd: string): (p: string) => string {
	return (p: string): string => {
		if (p.startsWith('/')) return normalizePath(p);
		if (cwd === '/') return normalizePath(`/${p}`);
		return normalizePath(`${cwd}/${p}`);
	};
}

export function createCwdSandbox(parentEnv: Sandbox, cwd: string): Sandbox {
	const scopedCwd = normalizePath(cwd);
	const resolvePath = makeResolvePath(scopedCwd);

	return {
		exec: (cmd, opts) =>
			parentEnv.exec(cmd, {
				cwd: opts?.cwd !== undefined ? resolvePath(opts.cwd) : scopedCwd,
				env: opts?.env,
				onOutput: opts?.onOutput,
				timeoutMs: opts?.timeoutMs,
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

/**
 * Wrap a just-bash factory into a {@link SandboxFactory}:
 * `useSandbox(bash(() => new Bash({ fs })))`.
 */
export function bash(factory: BashFactory): SandboxFactory {
	return {
		createSandbox: () => bashFactoryToSandbox(factory),
	};
}

export async function bashFactoryToSandbox(factory: BashFactory): Promise<Sandbox> {
	const bash = await factory();
	assertBashLike(bash);
	return createBashSandbox(bash);
}

function createBashSandbox(bash: BashLike): Sandbox {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p: string) => (p.startsWith('/') ? p : fs.resolvePath(cwd, p));

	return {
		exec: async (cmd, opts) => {
			// Pre-check before composing the timeout signal so a pre-aborted
			// call never schedules a stray timer (raceExecAbort re-checks, but
			// only after composition would have run).
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);

			// Just-bash has no native timeout option. Translate `timeoutMs`
			// into an AbortSignal and compose with the caller's signal so
			// bash factories observe deadlines with the same fidelity as
			// signal-aware sandbox adapters.
			const { mergedSignal } = composeTimeoutSignal(opts?.timeoutMs, opts?.signal);

			// The abort race applies here for contract uniformity: a
			// signal-blind Bash-like keeps executing in-process after the
			// early rejection (shared event loop, shared FS) — a signal-aware
			// one cancels via `mergedSignal` and the orphan window is bounded
			// by its kill latency.
			return raceExecAbort(
				cmd,
				() =>
					bash.exec(cmd, opts ? { cwd: opts.cwd, env: opts.env, signal: mergedSignal } : undefined),
				opts?.signal,
			);
		},
		readFile: (p) => fs.readFile(resolve(p)),
		readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
		writeFile: (p, content) => {
			const resolved = resolve(p);
			return writeFileCreatingParents(
				() => fs.writeFile(resolved, content),
				() => fs.mkdir(posixParentDir(resolved), { recursive: true }),
			);
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

/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value: unknown): value is BashLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'exec' in value &&
		'getCwd' in value &&
		'fs' in value &&
		typeof (value as any).exec === 'function' &&
		typeof (value as any).getCwd === 'function' &&
		// `typeof null === 'object'`, so an explicit null-check is required here.
		typeof (value as any).fs === 'object' &&
		(value as any).fs !== null
	);
}

function assertBashLike(value: unknown): asserts value is BashLike {
	if (!isBashLike(value)) {
		throw new Error('[flue] BashFactory must return a Bash-like object.');
	}
}

/**
 * Interface that remote sandbox providers must implement.
 *
 * `exec()` cancellation is expressed two ways. Sandbox adapters should honor at
 * least one — preferably `timeoutMs`, since most provider SDKs expose a
 * native timeout option but few support mid-flight cancellation:
 *
 *   - `timeoutMs?: number` (milliseconds): the **primary** cancellation
 *     contract. Forward to the provider's native timeout option (E2B
 *     `timeoutMs`, Daytona `timeout`, Modal `timeout`, etc.). Providers
 *     with coarser granularity may round the value up, never down.
 *     Required for parity with the LLM bash tool, which always passes a
 *     deadline hint when the model requests one.
 *   - `signal?: AbortSignal` (optional): for sandbox adapters whose SDK supports
 *     mid-flight cancellation (Mirage's executor, in-process bash). Lets
 *     Programmatic callers do ad-hoc `abort()`. Sandbox adapters that can't honor it
 *     should ignore it; the deadline is still enforced via `timeoutMs`, and
 *     the {@link sandboxFromDriver} wrapper owns caller-facing abort:
 *     on abort it rejects promptly and treats the still-running command as an
 *     orphan ({@link OrphanedExecSettlement}). Adapters must not implement
 *     their own abort race — a second one is redundant and splits the orphan
 *     bookkeeping.
 *
 * Sandbox adapters that support both should observe whichever fires first.
 *
 * Liveness: an adapter should ensure in-flight operations settle when the
 * sandbox dies, by whatever mechanism its provider SDK supports — native
 * rejection of in-flight calls, or polling a cheap control-plane status read
 * while a call is pending (the first-party Cloudflare adapter does the latter
 * internally). An adapter with no such mechanism carries an accepted
 * limitation: when the provider transport never settles a call after the
 * sandbox dies, that call may hang until the surrounding operation is
 * aborted. There is deliberately no per-command deadline in this contract —
 * agent commands are legitimately unbounded, and `timeoutMs` is the command's
 * own deadline, not an infrastructure liveness bound. An adapter that detects
 * sandbox death should reject with `SandboxDiedError` (exported from
 * `@flue/runtime`), so shell classification reports an infrastructure failure
 * rather than caller cancellation.
 */
export interface SandboxDriver {
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
			onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;
}

/** @deprecated Renamed to {@link SandboxDriver}. */
export type SandboxApi = SandboxDriver;

/**
 * Wrap a SandboxDriver into a live Sandbox. No just-bash, no intermediate
 * filesystem layer.
 *
 * `options.onOrphanSettled` observes {@link OrphanedExecSettlement}s: the
 * eventual settlement of commands whose caller was released early by an
 * abort. Adapter-facing only — the runtime never records orphan settlements.
 * `options.onObserverError` receives failures thrown by `onOrphanSettled` or
 * a caller's `exec.onOutput` callback without changing command settlement.
 */
export function sandboxFromDriver(
	driver: SandboxDriver,
	cwd: string,
	options?: {
		onOrphanSettled?: (settlement: OrphanedExecSettlement) => void;
		onObserverError?: (failure: SandboxObserverFailure) => void;
	},
): Sandbox {
	const resolvePath = makeResolvePath(cwd);
	const onOrphanSettled = options?.onOrphanSettled;
	const onObserverError = options?.onObserverError;

	return {
		async exec(
			command: string,
			execOptions?: {
				cwd?: string;
				env?: Record<string, string>;
				onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
				timeoutMs?: number;
				signal?: AbortSignal;
			},
		): Promise<ShellResult> {
			// Abort semantics live here — not in every sandbox adapter. Most
			// provider SDKs (E2B, Daytona, Modal, Boxd, etc.) don't accept an
			// AbortSignal, so adapters only wire `signal` into their provider
			// SDK when one supports it (Mirage, Vercel); the rest get the
			// `Sandbox.exec` abort contract for free: a pre-aborted call
			// never executes, and a mid-flight abort rejects promptly —
			// orphaning the remote command rather than awaiting it.
			const signal = execOptions?.signal;
			const onOutput = execOptions?.onOutput;
			const observedOutput = onOutput
				? (stream: 'stdout' | 'stderr', data: string): void => {
						if (signal?.aborted) return;
						invokeSandboxObserver('onOutput', () => onOutput(stream, data), onObserverError);
					}
				: undefined;
			return raceExecAbort(
				command,
				() =>
					driver.exec(command, {
						cwd: execOptions?.cwd !== undefined ? resolvePath(execOptions.cwd) : cwd,
						env: execOptions?.env,
						onOutput: observedOutput,
						timeoutMs: execOptions?.timeoutMs,
						signal,
					}),
				signal,
				onOrphanSettled,
				onObserverError,
			);
		},

		async readFile(path: string): Promise<string> {
			return driver.readFile(resolvePath(path));
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			return driver.readFileBuffer(resolvePath(path));
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			return writeFileCreatingParents(
				() => driver.writeFile(resolved, content),
				() => driver.mkdir(posixParentDir(resolved), { recursive: true }),
			);
		},

		async stat(path: string): Promise<FileStat> {
			return driver.stat(resolvePath(path));
		},

		async readdir(path: string): Promise<string[]> {
			return driver.readdir(resolvePath(path));
		},

		async exists(path: string): Promise<boolean> {
			return driver.exists(resolvePath(path));
		},

		async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
			return driver.mkdir(resolvePath(path), options);
		},

		async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
			return driver.rm(resolvePath(path), options);
		},

		cwd,

		resolvePath,
	};
}

/**
 * @deprecated Renamed to {@link sandboxFromDriver}. When removing this alias,
 * also drop the `duplicates` ignore for this file in the repo-root knip.json.
 */
export const createSandboxSessionEnv = sandboxFromDriver;
