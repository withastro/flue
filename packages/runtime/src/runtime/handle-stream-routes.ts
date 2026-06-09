/**
 * Durable Streams protocol read endpoints.
 *
 * Implements DS-compliant GET (catch-up, long-poll, SSE) and HEAD on any
 * {@link EventStreamStore} path. These are read-only — writes are internal
 * side-effects of agent execution and workflow lifecycle.
 *
 * @see https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md
 */

import type { EventStreamStore } from './event-stream-store.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const LONG_POLL_TIMEOUT_MS = 30_000;
const SSE_HEARTBEAT_MS = 15_000;

// DS protocol header names (matching @durable-streams/client constants).
const STREAM_NEXT_OFFSET = 'Stream-Next-Offset';
const STREAM_UP_TO_DATE = 'Stream-Up-To-Date';
const STREAM_CLOSED = 'Stream-Closed';
const STREAM_CURSOR = 'Stream-Cursor';

// SSE control event field names (camelCase per DS protocol Section 5.8).
const SSE_OFFSET_FIELD = 'streamNextOffset';
const SSE_CURSOR_FIELD = 'streamCursor';
const SSE_CLOSED_FIELD = 'streamClosed';
const SSE_UP_TO_DATE_FIELD = 'upToDate';

// Cursor epoch: 2024-10-09T00:00:00Z (matching DS reference server).
const CURSOR_EPOCH_MS = 1728432000000;
const CURSOR_INTERVAL_MS = 20_000;

// ─── Cursor generation ──────────────────────────────────────────────────────

function generateCursor(clientCursor?: string): string {
	const currentInterval = Math.floor((Date.now() - CURSOR_EPOCH_MS) / CURSOR_INTERVAL_MS);
	if (!clientCursor) return String(currentInterval);
	const clientInterval = parseInt(clientCursor, 10);
	if (!Number.isFinite(clientInterval) || clientInterval < currentInterval) {
		return String(currentInterval);
	}
	// Monotonic advancement: add jitter to prevent cache loops.
	const jitter = Math.floor(Math.random() * 180) + 1; // 1–180 intervals (20s–60min)
	return String(clientInterval + jitter);
}

// ─── ETag generation ────────────────────────────────────────────────────────

function generateETag(
	path: string,
	startOffset: string,
	endOffset: string,
	closed: boolean,
): string {
	const pathEncoded = typeof btoa === 'function' ? btoa(path) : Buffer.from(path).toString('base64');
	const closedSuffix = closed ? ':c' : '';
	return `"${pathEncoded}:${startOffset}:${endOffset}${closedSuffix}"`;
}

// ─── SSE encoding ───────────────────────────────────────────────────────────

function encodeSseData(payload: string): string {
	const lines = payload.split(/\r\n|\r|\n/);
	return lines.map((line) => `data:${line}`).join('\n') + '\n\n';
}

// ─── HEAD handler ───────────────────────────────────────────────────────────

/**
 * DS-compliant HEAD: returns stream metadata without a body.
 * 404 if the stream does not exist.
 */
export function handleStreamHead(store: EventStreamStore, path: string): Response {
	const meta = store.getStreamMeta(path);
	if (!meta) {
		return new Response(null, { status: 404 });
	}

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		[STREAM_NEXT_OFFSET]: meta.nextOffset,
		'cache-control': 'no-store',
	};
	if (meta.closed) {
		headers[STREAM_CLOSED] = 'true';
	}

	headers['etag'] = generateETag(path, '-1', meta.nextOffset, meta.closed);

	return new Response(null, { status: 200, headers });
}

// ─── GET handler ────────────────────────────────────────────────────────────

export interface HandleStreamReadOptions {
	store: EventStreamStore;
	path: string;
	request: Request;
}

/**
 * DS-compliant GET: catch-up, long-poll, or SSE mode based on `?live=` param.
 * 404 if the stream does not exist.
 */
export async function handleStreamRead(opts: HandleStreamReadOptions): Promise<Response> {
	const { store, path, request } = opts;
	const url = new URL(request.url);

	const offsetParam = url.searchParams.get('offset') ?? '-1';
	const liveRaw = url.searchParams.get('live');
	const cursor = url.searchParams.get('cursor') ?? undefined;

	// Validate live mode.
	if (liveRaw !== null && liveRaw !== 'long-poll' && liveRaw !== 'sse') {
		return new Response(JSON.stringify({ error: 'Invalid live mode. Use "long-poll" or "sse".' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	}
	const live = liveRaw as 'long-poll' | 'sse' | null;

	// Validate offset format: "-1", "now", or digits_digits (DS reference format).
	if (offsetParam !== '-1' && offsetParam !== 'now' && !/^\d+_\d+$/.test(offsetParam)) {
		return new Response(JSON.stringify({ error: 'Invalid offset format.' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	}

	// Stream must exist.
	const meta = store.getStreamMeta(path);
	if (!meta) {
		return new Response(null, { status: 404 });
	}

	if (live === 'sse') {
		return handleSseMode(store, path, offsetParam, request.signal);
	}

	// Read events from the store.
	const result = store.readEvents(path, { offset: offsetParam });

	if (live === 'long-poll') {
		return handleLongPollMode(store, path, offsetParam, cursor, result, request.signal);
	}

	return handleCatchUpMode(request, path, offsetParam, result);
}

// ─── Catch-up mode ──────────────────────────────────────────────────────────

function handleCatchUpMode(
	request: Request,
	path: string,
	offsetParam: string,
	result: ReturnType<EventStreamStore['readEvents']>,
): Response {
	const startOffset = offsetParam === 'now' ? 'now' : offsetParam;
	const isClosed = result.closed && result.upToDate;
	const etag = generateETag(path, startOffset, result.nextOffset, isClosed);

	// Handle conditional request.
	const conditional = checkConditional(request, etag);
	if (conditional) return conditional;

	const body = JSON.stringify(result.events.map((e) => e.data));

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		[STREAM_NEXT_OFFSET]: result.nextOffset,
		'cache-control': 'no-store',
		'etag': etag,
	};

	if (result.upToDate) {
		headers[STREAM_UP_TO_DATE] = 'true';
	}
	if (isClosed) {
		headers[STREAM_CLOSED] = 'true';
	}

	return new Response(body, { status: 200, headers });
}

// ─── Long-poll mode ─────────────────────────────────────────────────────────

async function handleLongPollMode(
	store: EventStreamStore,
	path: string,
	offsetParam: string,
	clientCursor: string | undefined,
	result: ReturnType<EventStreamStore['readEvents']>,
	signal: AbortSignal,
): Promise<Response> {
	// If we already have data, return it immediately (same as catch-up + cursor).
	if (result.events.length > 0) {
		const body = JSON.stringify(result.events.map((e) => e.data));
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			[STREAM_NEXT_OFFSET]: result.nextOffset,
			[STREAM_CURSOR]: generateCursor(clientCursor),
		};
		if (result.upToDate) {
			headers[STREAM_UP_TO_DATE] = 'true';
		}
		if (result.closed && result.upToDate) {
			headers[STREAM_CLOSED] = 'true';
		}
		const startOffset = offsetParam === 'now' ? 'now' : offsetParam;
		headers['etag'] = generateETag(path, startOffset, result.nextOffset, result.closed && result.upToDate);
		return new Response(body, { status: 200, headers });
	}

	// At tail with no data. If stream is closed, return 204 immediately.
	if (result.closed && result.upToDate) {
		return new Response(null, {
			status: 204,
			headers: {
				[STREAM_NEXT_OFFSET]: result.nextOffset,
				[STREAM_UP_TO_DATE]: 'true',
				[STREAM_CLOSED]: 'true',
			},
		});
	}

	// Wait for new data or timeout.
	const waitResult = await waitForStreamData(store, path, signal);

	if (waitResult === 'aborted') {
		return new Response(null, { status: 499 });
	}

	if (waitResult === 'timeout') {
		// Re-check closed status in case the stream closed during wait.
		const currentMeta = store.getStreamMeta(path);
		const headers: Record<string, string> = {
			[STREAM_NEXT_OFFSET]: result.nextOffset,
			[STREAM_UP_TO_DATE]: 'true',
			[STREAM_CURSOR]: generateCursor(clientCursor),
		};
		if (currentMeta?.closed) {
			headers[STREAM_CLOSED] = 'true';
		}
		return new Response(null, { status: 204, headers });
	}

	// 'data' — new data available. Re-read from the store.
	const freshResult = store.readEvents(path, { offset: offsetParam });
	if (freshResult.events.length > 0) {
		const body = JSON.stringify(freshResult.events.map((e) => e.data));
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			[STREAM_NEXT_OFFSET]: freshResult.nextOffset,
			[STREAM_CURSOR]: generateCursor(clientCursor),
		};
		if (freshResult.upToDate) {
			headers[STREAM_UP_TO_DATE] = 'true';
		}
		if (freshResult.closed && freshResult.upToDate) {
			headers[STREAM_CLOSED] = 'true';
		}
		const startOffset = offsetParam === 'now' ? 'now' : offsetParam;
		headers['etag'] = generateETag(path, startOffset, freshResult.nextOffset, freshResult.closed && freshResult.upToDate);
		return new Response(body, { status: 200, headers });
	}

	// Stream was notified (likely closed) but no new events.
	const closedMeta = store.getStreamMeta(path);
	const headers204: Record<string, string> = {
		[STREAM_NEXT_OFFSET]: result.nextOffset,
		[STREAM_UP_TO_DATE]: 'true',
		[STREAM_CURSOR]: generateCursor(clientCursor),
	};
	if (closedMeta?.closed) {
		headers204[STREAM_CLOSED] = 'true';
	}
	return new Response(null, { status: 204, headers: headers204 });
}

function waitForStreamData(
	store: EventStreamStore,
	path: string,
	signal: AbortSignal,
): Promise<'data' | 'timeout' | 'aborted'> {
	return new Promise<'data' | 'timeout' | 'aborted'>((resolve) => {
		if (signal.aborted) {
			resolve('aborted');
			return;
		}

		let settled = false;
		const settle = (result: 'data' | 'timeout' | 'aborted') => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const unsub = store.subscribe(path, () => settle('data'));
		const timer = setTimeout(() => settle('timeout'), LONG_POLL_TIMEOUT_MS);
		const onAbort = () => settle('aborted');
		signal.addEventListener('abort', onAbort, { once: true });

		function cleanup() {
			unsub();
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
		}
	});
}

// ─── SSE mode ───────────────────────────────────────────────────────────────

function handleSseMode(
	store: EventStreamStore,
	path: string,
	offsetParam: string,
	signal: AbortSignal,
): Response {
	const encoder = new TextEncoder();
	let isConnected = true;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			// Track client disconnects.
			signal.addEventListener('abort', () => {
				isConnected = false;
				cleanup();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			}, { once: true });

			// Start heartbeat.
			heartbeatTimer = setInterval(() => {
				if (!isConnected) return;
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					isConnected = false;
					cleanup();
				}
			}, SSE_HEARTBEAT_MS);

			// Run the SSE loop asynchronously.
			runSseLoop(store, path, offsetParam, controller, encoder, signal, () => isConnected).finally(() => {
				cleanup();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			});
		},
		cancel() {
			isConnected = false;
			cleanup();
		},
	});

	function cleanup() {
		if (heartbeatTimer !== undefined) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	}

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
		},
	});
}

async function runSseLoop(
	store: EventStreamStore,
	path: string,
	offsetParam: string,
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	signal: AbortSignal,
	isConnected: () => boolean,
): Promise<void> {
	let currentOffset = offsetParam;

	while (isConnected()) {
		const result = store.readEvents(path, { offset: currentOffset });

		// Emit data events.
		if (result.events.length > 0) {
			const dataPayload = JSON.stringify(result.events.map((e) => e.data));
			const sseData = `event: data\n${encodeSseData(dataPayload)}`;
			try {
				controller.enqueue(encoder.encode(sseData));
			} catch {
				return;
			}
		}

		// Emit control event.
		const clientAtTail = result.upToDate;
		const streamClosed = result.closed && clientAtTail;

		const controlData: Record<string, string | boolean> = {
			[SSE_OFFSET_FIELD]: result.nextOffset,
		};

		if (streamClosed) {
			controlData[SSE_CLOSED_FIELD] = true;
		} else {
			controlData[SSE_CURSOR_FIELD] = generateCursor();
			if (clientAtTail) {
				controlData[SSE_UP_TO_DATE_FIELD] = true;
			}
		}

		const controlSse = `event: control\n${encodeSseData(JSON.stringify(controlData))}`;
		try {
			controller.enqueue(encoder.encode(controlSse));
		} catch {
			return;
		}

		// Update current offset for next iteration.
		currentOffset = result.nextOffset;

		// If stream is closed and we're at the tail, we're done.
		if (streamClosed) {
			return;
		}

		// If not at tail, loop immediately to read more data.
		if (!clientAtTail) {
			continue;
		}

		// At tail, stream is open. Wait for new data.
		const waitResult = await waitForStreamData(store, path, signal);
		if (waitResult === 'aborted') {
			return;
		}
		if (waitResult === 'timeout') {
			// Emit keep-alive control event and continue waiting.
			const keepAlive: Record<string, string | boolean> = {
				[SSE_OFFSET_FIELD]: currentOffset,
				[SSE_CURSOR_FIELD]: generateCursor(),
				[SSE_UP_TO_DATE_FIELD]: true,
			};
			try {
				controller.enqueue(encoder.encode(`event: control\n${encodeSseData(JSON.stringify(keepAlive))}`));
			} catch {
				return;
			}
			// Continue the loop — will re-read and wait again.
		}
		// 'data' — loop back to read new events.
	}
}

// ─── If-None-Match ──────────────────────────────────────────────────────────

/**
 * Check the request's If-None-Match header and return a 304 if the
 * ETag matches. Returns null if the request should proceed normally.
 */
function checkConditional(request: Request, etag: string): Response | null {
	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, { status: 304, headers: { etag } });
	}
	return null;
}
