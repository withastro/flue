/**
 * Typed Durable Streams wrapper for Flue event consumption.
 *
 * Wraps `@durable-streams/client` to provide an {@link AsyncIterable} of
 * {@link FlueEvent} values with automatic reconnection, offset-based replay,
 * and SSE live tailing.
 */

import { stream } from '@durable-streams/client';
import type { BackoffOptions, LiveMode } from '@durable-streams/client';
import type { FlueEvent } from '../types.ts';

/** Options for streaming Flue events from an agent instance or workflow run. */
export interface FlueStreamOptions {
	/** Starting offset. Defaults to `'-1'` (full history). */
	offset?: string;
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
	 * Resume offset of the most recently fetched batch (the server's
	 * `Stream-Next-Offset`). Advances per HTTP response, not per delivered
	 * event — every event in a batch observes the batch's final offset, so
	 * checkpointing this value mid-batch and resuming from it skips the rest
	 * of that batch. For per-event checkpoints use the event's `eventIndex`
	 * (event index == stream sequence).
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
 * Pulls events directly from the DS client's `jsonStream()` ReadableStream
 * reader in each `next()` call. This provides natural backpressure — the DS
 * client only fetches the next batch when the consumer is ready — and avoids
 * unbounded memory growth for slow consumers.
 */
export function createFlueEventStream<T = FlueEvent>(
	streamOpts: FlueStreamOptions,
	connectionOpts: StreamConnectionOptions,
): FlueEventStream<T> {
	const abortController = new AbortController();

	// Link external signal to our controller. Store the handler so we can
	// remove it when the stream completes naturally (avoids retaining the
	// closure scope on long-lived AbortSignals).
	let removeExternalAbortListener: (() => void) | undefined;
	if (streamOpts.signal) {
		if (streamOpts.signal.aborted) {
			abortController.abort(streamOpts.signal.reason);
		} else {
			const onAbort = () => abortController.abort(streamOpts.signal!.reason);
			streamOpts.signal.addEventListener('abort', onAbort, { once: true });
			removeExternalAbortListener = () => streamOpts.signal!.removeEventListener('abort', onAbort);
		}
	}

	const fetch = connectionOpts.fetch ?? globalThis.fetch;

	let responsePromise: Promise<Awaited<ReturnType<typeof stream<T>>>> | undefined;
	const connect = (): Promise<Awaited<ReturnType<typeof stream<T>>>> => {
		if (responsePromise) return responsePromise;
		if (abortController.signal.aborted) {
			return Promise.reject(abortController.signal.reason ?? new DOMException('Aborted', 'AbortError'));
		}
		responsePromise = stream<T>({
			url: connectionOpts.url,
			offset: streamOpts.offset ?? '-1',
			live: streamOpts.live ?? true,
			json: true,
			signal: abortController.signal,
			fetch,
			backoffOptions: streamOpts.backoffOptions,
			warnOnHttp: false,
		});
		return responsePromise;
	};

	const cancel = (reason?: unknown) => {
		abortController.abort(reason);
		removeExternalAbortListener?.();
	};

	// Reader is initialized lazily on the first next() call.
	let reader: ReadableStreamDefaultReader<T> | undefined;
	let readerDone = false;
	let currentOffset = streamOpts.offset ?? '-1';

	const iterator: AsyncIterator<T> = {
		async next(): Promise<IteratorResult<T>> {
			if (abortController.signal.aborted) {
				readerDone = true;
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			if (!reader) {
				try {
					const res = await connect();
					currentOffset = res.offset;
					reader = res.jsonStream().getReader();
				} catch (err) {
					if (abortController.signal.aborted || isAbortError(err)) {
						readerDone = true;
						removeExternalAbortListener?.();
						return { value: undefined as T, done: true };
					}
					throw err;
				}
			}

			if (readerDone) {
				return { value: undefined as T, done: true };
			}

			try {
				const { value, done } = await reader.read();
				if (responsePromise) currentOffset = (await responsePromise).offset;
				if (done) {
					readerDone = true;
					removeExternalAbortListener?.();
					return { value: undefined as T, done: true };
				}
				return { value, done: false };
			} catch (err) {
				readerDone = true;
				removeExternalAbortListener?.();
				if (abortController.signal.aborted || isAbortError(err)) {
					return { value: undefined as T, done: true };
				}
				throw err;
			}
		},
		async return(): Promise<IteratorResult<T>> {
			readerDone = true;
			// cancel() on an errored stream returns a rejected promise — swallow
			// it so a consumer breaking out of the loop can't trigger an
			// unhandled rejection.
			try { void reader?.cancel().catch(() => {}); } catch { /* ignore */ }
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

function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === 'AbortError') return true;
	if (err instanceof Error && err.name === 'AbortError') return true;
	return false;
}
