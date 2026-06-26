/**
 * Typed Durable Streams wrapper for Flue event consumption.
 *
 * Wraps `@durable-streams/client` to provide an {@link AsyncIterable} of
 * {@link FlueEvent} values with automatic reconnection, offset-based replay,
 * and SSE live tailing.
 */

import type { BackoffOptions, LiveMode } from '@durable-streams/client';
import { stream } from '@durable-streams/client';
import type { FlueEvent } from '../types.ts';

/** Options for streaming Flue events from an agent instance or workflow run. */
export interface FlueStreamOptions {
	/** Starting offset. Defaults to `'-1'` (full history). */
	offset?: string;
	/** Limit an `offset: '-1'` read to at most the most recent number of events. */
	tail?: number;
	/** Live tailing mode. Defaults to `true` (long-poll). */
	live?: LiveMode;
	/** Abort signal to cancel the stream. */
	signal?: AbortSignal;
	/** Retry behavior for stream connection attempts. */
	backoffOptions?: BackoffOptions;
}

/**
 * Async iterable of Flue events backed by a Durable Streams connection.
 *
 * Supports `for await...of` and explicit {@link cancel}. Breaking out of a
 * `for await` loop automatically cleans up the underlying connection.
 */
export interface FlueEventStream<T = FlueEvent> extends AsyncIterable<T> {
	/** Cancel the stream and abort the underlying connection. */
	cancel(reason?: unknown): void;
	/**
	 * Resume offset checkpoint (the server's `Stream-Next-Offset`). Advances
	 * per delivered batch: it moves to a batch's next-offset only once every
	 * event in that batch has been yielded, so resuming from a checkpointed
	 * value never skips undelivered events — at worst it re-delivers events
	 * of the batch in flight when the checkpoint was taken (at-least-once).
	 * Event indexes identify and order events but are not stream offsets.
	 */
	readonly offset: string;
}

/** Internal options passed by the FlueClient to configure the DS connection. */
export interface StreamConnectionOptions {
	/** Full URL of the stream endpoint. */
	url: string;
	/** Custom fetch implementation. */
	fetch?: typeof globalThis.fetch;
}

/**
 * Creates a {@link FlueEventStream} that yields individual {@link FlueEvent}
 * values from a Durable Streams endpoint.
 *
 * Consumes the DS client's `subscribeJson()` batches and yields events one at
 * a time. Each batch's subscriber promise resolves only after the batch's
 * last event has been yielded, which provides natural backpressure (avoiding
 * unbounded memory growth for slow consumers) and pairs every event with its
 * own batch's `Stream-Next-Offset`. The DS response's live `offset` getter is
 * never used as a checkpoint: response prefetch advances it past batches that
 * have not been delivered yet.
 */
export class UnsupportedFlueEventVersionError extends Error {
	readonly received: unknown;
	readonly supported = 3;

	constructor(received: unknown) {
		super(`Flue event version ${String(received)} is unsupported. Clear historical event data created by an earlier Flue beta.`);
		this.name = 'UnsupportedFlueEventVersionError';
		this.received = received;
	}
}

export function createFlueEventStream<T = FlueEvent>(
	streamOpts: FlueStreamOptions,
	connectionOpts: StreamConnectionOptions,
	validate: (value: T) => T = assertSupportedEventVersion,
): FlueEventStream<T> {
	const abortController = new AbortController();

	// Link external signal to our controller. Store the handler so we can
	// remove it when the stream completes naturally (avoids retaining the
	// closure scope on long-lived AbortSignals).
	let removeExternalAbortListener: (() => void) | undefined;
	if (streamOpts.signal) {
		const signal = streamOpts.signal;
		if (signal.aborted) {
			abortController.abort(signal.reason);
		} else {
			const onAbort = () => abortController.abort(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
			removeExternalAbortListener = () => signal.removeEventListener('abort', onAbort);
		}
	}

	const fetch = connectionOpts.fetch ?? globalThis.fetch;
	const url = new URL(connectionOpts.url);
	if (streamOpts.tail !== undefined) url.searchParams.set('tail', String(streamOpts.tail));

	let connectOffset = streamOpts.offset ?? '-1';
	let responsePromise: Promise<Awaited<ReturnType<typeof stream<T>>>> | undefined;
	const connect = (): Promise<Awaited<ReturnType<typeof stream<T>>>> => {
		if (responsePromise) return responsePromise;
		if (abortController.signal.aborted) {
			return Promise.reject(
				abortController.signal.reason ?? new DOMException('Aborted', 'AbortError'),
			);
		}
		responsePromise = stream<T>({
			url: url.toString(),
			offset: connectOffset,
			live: streamOpts.live ?? true,
			json: true,
			signal: abortController.signal,
			fetch,
			backoffOptions: streamOpts.backoffOptions,
			warnOnHttp: false,
		});
		return responsePromise;
	};

	// Batches arrive through subscribeJson(); each subscriber promise resolves
	// only once every event in its batch has been yielded, providing
	// backpressure. `currentOffset` advances per *delivered* batch using the
	// batch's own Stream-Next-Offset header — never the DS response's live
	// `offset` getter, which response prefetch advances past undelivered
	// batches.
	//
	// Termination must likewise be consumption-ordered: the DS response's
	// `closed` promise resolves when *fetching* finishes, while batches can
	// still be buffered or downloading, so it cannot end iteration directly.
	// Instead the final batch is identified from its own metadata: every
	// `live: false` connection yields exactly one response, and live modes
	// end with a batch whose `streamClosed` flag is set. The lone exception
	// is an SSE connection that ends without a stream-closed control event;
	// for that case `closed` is used as a backstop after a macrotask barrier
	// (all SSE batches are synthetic in-memory responses, so any still
	// undelivered ones land within microtasks once fetching has finished).
	let started = false;
	let pending:
		| {
				items: readonly T[];
				next: number;
				offset: string;
				final: { upToDate: boolean } | undefined;
		  }
		| undefined;
	let drained: (() => void) | undefined;
	let notify: (() => void) | undefined;
	let deliveryDone = false;
	let fetchDone = false;
	let finalBatch: { upToDate: boolean; offset: string } | undefined;
	let streamFailure: { error: unknown } | undefined;
	let terminalFailure: unknown;
	let currentOffset = streamOpts.offset ?? '-1';

	/** Wakes a next() call waiting for the next batch, end, or cancellation. */
	const wake = () => {
		const resolve = notify;
		notify = undefined;
		resolve?.();
	};

	/** Resolves the current batch's subscriber promise. */
	const releaseBatch = () => {
		const resolve = drained;
		drained = undefined;
		resolve?.();
	};

	const cancel = (reason?: unknown) => {
		abortController.abort(reason);
		removeExternalAbortListener?.();
		// Unblock the subscriber loop and any waiting next() so both can
		// observe the abort.
		releaseBatch();
		wake();
	};

	const startConsuming = (res: Awaited<ReturnType<typeof stream<T>>>) => {
		res.subscribeJson<T>((batch) => {
			if (abortController.signal.aborted) return;
			const final =
				batch.streamClosed || streamOpts.live === false ? { upToDate: batch.upToDate } : undefined;
			if (batch.items.length === 0) {
				// Nothing to deliver; the batch's next-offset is still a safe
				// resume point because no undelivered event lies behind it.
				currentOffset = batch.offset;
				if (final) {
					finalBatch = { ...final, offset: batch.offset };
					deliveryDone = true;
				}
				wake();
				return;
			}
			return new Promise<void>((resolve) => {
				pending = { items: batch.items, next: 0, offset: batch.offset, final };
				drained = resolve;
				wake();
			});
		});
		res.closed.then(
			() => {
				fetchDone = true;
				wake();
			},
			(error: unknown) => {
				streamFailure = { error };
				deliveryDone = true;
				wake();
			},
		);
	};

	const nextResult = async (): Promise<IteratorResult<T>> => {
		while (true) {
			if (terminalFailure !== undefined) throw terminalFailure;
			if (abortController.signal.aborted) {
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			if (!started) {
				started = true;
				try {
					startConsuming(await connect());
				} catch (err) {
					// Allow a later next() call to surface the same rejection
					// again instead of waiting forever for batches that will
					// never arrive.
					started = false;
					removeExternalAbortListener?.();
					if (abortController.signal.aborted || isAbortError(err)) {
						return { value: undefined as T, done: true };
					}
					throw err;
				}
			}

			if (pending) {
				let value: T;
				try {
					value = validate(pending.items[pending.next] as T);
				} catch (error) {
					terminalFailure = error;
					deliveryDone = true;
					pending = undefined;
					releaseBatch();
					cancel(error);
					throw error;
				}
				pending.next++;
				if (pending.next >= pending.items.length) {
					currentOffset = pending.offset;
					if (pending.final) {
						finalBatch = { ...pending.final, offset: pending.offset };
						deliveryDone = true;
					}
					pending = undefined;
					releaseBatch();
				}
				return { value, done: false };
			}

			if (deliveryDone) {
				if (streamFailure) {
					const { error } = streamFailure;
					streamFailure = undefined;
					removeExternalAbortListener?.();
					if (abortController.signal.aborted || isAbortError(error)) {
						return { value: undefined as T, done: true };
					}
					throw error;
				}
				// The DS client makes exactly one request per `live: false`
				// stream, even when the server caps the catch-up batch and
				// reports more data remains (no Stream-Up-To-Date header).
				// Reconnect from the latest offset until up-to-date.
				if (
					streamOpts.live === false &&
					finalBatch &&
					!finalBatch.upToDate &&
					finalBatch.offset !== connectOffset
				) {
					connectOffset = finalBatch.offset;
					responsePromise = undefined;
					started = false;
					deliveryDone = false;
					fetchDone = false;
					finalBatch = undefined;
					continue;
				}
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			if (fetchDone && streamOpts.live === 'sse') {
				// SSE backstop: the connection ended without a stream-closed
				// control event. Let any remaining synthetic batches land
				// (they resolve within microtasks), then finish.
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				if (pending || deliveryDone || abortController.signal.aborted) continue;
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			// Wait for the next batch, stream end, or cancellation.
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
	};

	// The async-iterator protocol permits calling next() again before the
	// previous call settles, but the body above is not reentrant: `notify`
	// holds a single waiter, so a second concurrent call would silently drop
	// the first. Serialize calls so each runs only after the previous settles.
	let lastNext: Promise<unknown> | undefined;
	const iterator: AsyncIterator<T> = {
		next(): Promise<IteratorResult<T>> {
			const result = lastNext ? lastNext.then(nextResult, nextResult) : nextResult();
			lastNext = result.catch(() => {});
			return result;
		},
		async return(): Promise<IteratorResult<T>> {
			cancel();
			return { value: undefined as T, done: true };
		},
	};

	return {
		cancel,
		get offset() {
			return currentOffset;
		},
		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
}

function assertSupportedEventVersion<T>(value: T): T {
	const version = value && typeof value === 'object' ? (value as { v?: unknown }).v : undefined;
	if (version !== 3) throw new UnsupportedFlueEventVersionError(version);
	return value;
}

function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === 'AbortError') return true;
	if (err instanceof Error && err.name === 'AbortError') return true;
	return false;
}
