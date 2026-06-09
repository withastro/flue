/**
 * Typed Durable Streams wrapper for Flue event consumption.
 *
 * Wraps `@durable-streams/client` to provide an {@link AsyncIterable} of
 * {@link FlueEvent} values with automatic reconnection, offset-based replay,
 * and SSE live tailing.
 */

import {
	stream,
	type LiveMode,
	type StreamResponse,
} from '@durable-streams/client';
import type { FlueEvent } from '../types.ts';

/** Options for streaming Flue events from an agent instance or workflow run. */
export interface FlueStreamOptions {
	/** Starting offset. Defaults to `'-1'` (full history). */
	offset?: string;
	/** Live tailing mode. Defaults to `true` (auto SSE/long-poll). */
	live?: LiveMode;
	/** Abort signal to cancel the stream. */
	signal?: AbortSignal;
}

/**
 * Async iterable of Flue events backed by a Durable Streams connection.
 *
 * Supports `for await...of` and explicit {@link cancel}. Breaking out of a
 * `for await` loop automatically cleans up the underlying connection.
 */
export interface FlueEventStream<T = FlueEvent> extends AsyncIterable<T> {
	/** The underlying DS client response. Exposes `offset`, `upToDate`, `streamClosed`, etc. */
	readonly response: Promise<StreamResponse<T>>;
	/** Cancel the stream and abort the underlying connection. */
	cancel(reason?: unknown): void;
}

/** Internal options passed by the FlueClient to configure the DS connection. */
export interface StreamConnectionOptions {
	/** Full URL of the stream endpoint. */
	url: string;
	/** Custom fetch implementation. */
	fetch?: typeof globalThis.fetch;
	/** Async header factory called per-request (supports token refresh on reconnection). */
	resolveHeaders?: () => Promise<Record<string, string>>;
}

/**
 * Creates a {@link FlueEventStream} that yields individual {@link FlueEvent}
 * values from a Durable Streams endpoint.
 *
 * Uses the DS client's `subscribeJson` callback API to bridge batches into an
 * async iterator. The subscription is registered synchronously after the
 * DS `stream()` promise resolves, before any data can be consumed, ensuring
 * no events are lost.
 */
export function createFlueEventStream<T = FlueEvent>(
	streamOpts: FlueStreamOptions,
	connectionOpts: StreamConnectionOptions,
): FlueEventStream<T> {
	const abortController = new AbortController();

	// Link external signal to our controller.
	if (streamOpts.signal) {
		if (streamOpts.signal.aborted) {
			abortController.abort(streamOpts.signal.reason);
		} else {
			streamOpts.signal.addEventListener(
				'abort',
				() => abortController.abort(streamOpts.signal!.reason),
				{ once: true },
			);
		}
	}

	// Wrap fetch to inject auth headers per-request. This ensures tokens
	// refresh on SSE reconnection (long-lived connections). We intercept
	// at the fetch level rather than using DS HeadersRecord because our
	// HttpClient produces a flat Record<string, string> from an async
	// factory — we don't know the keys upfront.
	const baseFetch = connectionOpts.fetch ?? globalThis.fetch;
	const resolveHeaders = connectionOpts.resolveHeaders;

	const wrappedFetch: typeof globalThis.fetch = resolveHeaders
		? async (input, init) => {
				const resolved = await resolveHeaders();
				const mergedHeaders = {
					...resolved,
					...(init?.headers as Record<string, string> | undefined),
				};
				return baseFetch(input, { ...init, headers: mergedHeaders });
			}
		: baseFetch;

	const responsePromise = stream<T>({
		url: connectionOpts.url,
		offset: streamOpts.offset ?? '-1',
		live: streamOpts.live ?? true,
		json: true,
		signal: abortController.signal,
		fetch: wrappedFetch,
		warnOnHttp: false,
	});

	const cancel = (reason?: unknown) => abortController.abort(reason);

	// Async iterator state, initialized lazily in the first next() call.
	let initialized = false;
	let initError: unknown;
	const queue: T[] = [];
	let notify: (() => void) | undefined;
	let done = false;

	async function ensureInitialized(): Promise<void> {
		if (initialized) return;
		initialized = true;
		try {
			const res = await responsePromise;

			// Use the json() accumulator + jsonStream() approach:
			// jsonStream() returns a ReadableStream<T> that yields individual items.
			// We read from it in a background task, pushing items to the queue.
			// This avoids the subscribeJson/closed race: jsonStream() is a pull-based
			// ReadableStream that the DS client fills from its internal response
			// pipeline. When the pipeline completes, the stream closes.
			const readable = res.jsonStream();
			const reader = readable.getReader();

			// Read in the background — push items to queue and notify the iterator.
			(async () => {
				try {
					while (true) {
						const { value, done: readerDone } = await reader.read();
						if (readerDone) break;
						queue.push(value);
						notify?.();
						notify = undefined;
					}
				} catch (err) {
					if (!isAbortError(err)) {
						initError = err;
					}
				} finally {
					done = true;
					notify?.();
					notify = undefined;
				}
			})();
		} catch (err) {
			if (!isAbortError(err)) {
				initError = err;
			}
			done = true;
		}
	}

	const iterator: AsyncIterator<T> = {
		async next(): Promise<IteratorResult<T>> {
			await ensureInitialized();

			while (queue.length === 0 && !done) {
				await new Promise<void>((r) => {
					notify = r;
				});
			}

			if (queue.length > 0) {
				return { value: queue.shift()!, done: false };
			}

			if (initError) {
				throw initError;
			}

			return { value: undefined as T, done: true };
		},
		async return(): Promise<IteratorResult<T>> {
			cancel();
			done = true;
			notify?.();
			notify = undefined;
			return { value: undefined as T, done: true };
		},
	};

	return {
		response: responsePromise,
		cancel,
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
