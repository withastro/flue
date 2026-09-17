/** Cancellation primitives shared by prompt, skill, task, and shell calls. */

import type { CallHandle } from './types.ts';

/** Build a standard `AbortError` (`DOMException`) carrying the signal's reason as `cause`. */
export function abortErrorFor(signal: AbortSignal): Error {
	const reason = signal.reason;
	const message =
		reason instanceof Error && reason.message
			? reason.message
			: typeof reason === 'string' && reason
				? reason
				: 'The operation was aborted.';
	const error = new DOMException(message, 'AbortError');
	// `cause` is read-only on DOMException in some runtimes.
	try {
		Object.defineProperty(error, 'cause', { value: reason, configurable: true });
	} catch {
		/* leave cause unset */
	}
	return error;
}

/**
 * Translate a millisecond deadline into an `AbortSignal` and compose it with
 * the caller's signal. Single implementation of the timeout-to-signal
 * cancellation composition shared by the LLM bash tool and the
 * signal-translating `Sandbox` adapters (bash factory, local).
 *
 * Returns both signals: callers that distinguish a recoverable timeout from
 * a host abort (the bash tool's 124-shaped result) need `timeoutSignal` on
 * its own; everything downstream gets `mergedSignal`.
 */
export function composeTimeoutSignal(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): { timeoutSignal: AbortSignal | undefined; mergedSignal: AbortSignal | undefined } {
	const timeoutSignal = typeof timeoutMs === 'number' ? AbortSignal.timeout(timeoutMs) : undefined;
	const mergedSignal =
		signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal);
	return { timeoutSignal, mergedSignal };
}

/** Appended to the abort error when the abandoned work may still be running. */
const ABANDONED_TOOL_SUFFIX =
	' The tool execution could not be confirmed cancelled and may still be running.';

/**
 * Await `run()`, but reject promptly with an `AbortError` when `signal`
 * fires instead of waiting for the promise — the pi tool loop awaits tool
 * promises without racing its own signal, so a signal-deaf tool (a sandbox
 * file op with no abort plumbing, a wedged provider SDK) would otherwise
 * wedge the turn past every abort and deadline. The abandoned promise is
 * orphaned under the same contract as an orphaned exec: both of its
 * settlement paths are consumed so nothing surfaces as an unhandled
 * rejection, and its eventual result is discarded — the conversation
 * records the terminal story at abort time. Signal-aware tools reject on
 * their own first; the race is then a no-op.
 */
export function abandonToolOnAbort<T>(
	run: () => Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortErrorFor(signal));
	if (!signal) return run();

	let pending: Promise<T>;
	try {
		pending = run();
	} catch (error) {
		return Promise.reject(error);
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;

		const onAbort = (): void => {
			// One macrotask of grace before abandoning: an abort-aware inner
			// racer (raceExecAbort's orphan contract, a fetch rejecting on the
			// same signal) delivers its own, more specific rejection first —
			// its continuation hops are microtasks, which all drain before a
			// timer callback — and this abandonment becomes a no-op.
			setTimeout(() => {
				if (settled) return;
				settled = true;
				pending.then(
					() => {},
					() => {},
				);
				const base = abortErrorFor(signal);
				const error = new DOMException(base.message + ABANDONED_TOOL_SUFFIX, 'AbortError');
				try {
					Object.defineProperty(error, 'cause', { value: signal.reason, configurable: true });
				} catch {
					/* leave cause unset */
				}
				reject(error);
			}, 0);
		};
		signal.addEventListener('abort', onAbort, { once: true });

		pending.then(
			(result) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener('abort', onAbort);
				// An abort landing in the same tick as completion still rejects —
				// no stale success after the turn's terminal story is decided.
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
 * Wrap an async `run` function in a `CallHandle`. The handle's internal
 * signal fires when `externalSignal` aborts or when `handle.abort()` is
 * called.
 */
export function createCallHandle<T>(
	externalSignal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): CallHandle<T> {
	const controller = new AbortController();

	let externalListener: (() => void) | undefined;
	if (externalSignal) {
		if (externalSignal.aborted) {
			controller.abort(externalSignal.reason);
		} else {
			externalListener = () => controller.abort(externalSignal.reason);
			externalSignal.addEventListener('abort', externalListener, { once: true });
		}
	}

	const promise = run(controller.signal).finally(() => {
		if (externalListener && externalSignal) {
			externalSignal.removeEventListener('abort', externalListener);
		}
	});
	// Callers may never await the handle (fire-and-forget calls, or aborting
	// and dropping the handle) — keep a rejection from surfacing as an
	// unhandled-rejection crash. `then()` below still returns the rejecting
	// promise to consumers that do await.
	promise.catch(() => {});

	return {
		signal: controller.signal,
		abort(reason?: unknown) {
			controller.abort(reason);
		},
		// CallHandle implements the full Promise interface by delegating to
		// the internal promise, so callers can `await handle` or chain
		// `.then()`/`.catch()`/`.finally()` without subclassing Promise.
		// biome-ignore lint/suspicious/noThenProperty: intentional thenable
		then(onFulfilled, onRejected) {
			return promise.then(onFulfilled, onRejected);
		},
		catch(onRejected) {
			return promise.catch(onRejected);
		},
		finally(onFinally) {
			return promise.finally(onFinally);
		},
		[Symbol.toStringTag]: 'Promise',
	};
}
