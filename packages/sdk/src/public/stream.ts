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

	// Reader is initialized lazily on the first next() call.
	let reader: ReadableStreamDefaultReader<T> | undefined;
	let readerDone = false;

	const iterator: AsyncIterator<T> = {
		async next(): Promise<IteratorResult<T>> {
			if (!reader) {
				try {
					const res = await responsePromise;
					reader = res.jsonStream().getReader();
				} catch (err) {
					if (isAbortError(err)) {
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
				if (done) {
					readerDone = true;
					return { value: undefined as T, done: true };
				}
				return { value, done: false };
			} catch (err) {
				readerDone = true;
				if (isAbortError(err)) {
					return { value: undefined as T, done: true };
				}
				throw err;
			}
		},
		async return(): Promise<IteratorResult<T>> {
			readerDone = true;
			cancel();
			return { value: undefined as T, done: true };
		},
	};

	return {
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
