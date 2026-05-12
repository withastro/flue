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

	return {
		signal: controller.signal,
		abort(reason?: unknown) {
			controller.abort(reason);
		},
		then(onFulfilled, onRejected) {
			return promise.then(onFulfilled, onRejected);
		},
	};
}
