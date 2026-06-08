import type { HttpClient } from '../http.ts';
import type { FlueEvent } from '../types.ts';

/** Options for streaming workflow-run events over server-sent events. */
export interface RunStreamOptions {
	/** Resume after this event index. */
	lastEventId?: number;
	/** Stop consuming events when aborted. */
	signal?: AbortSignal;
	/** Maximum reconnection attempts after an interrupted stream. Defaults to `3`. */
	maxRetries?: number;
	/** Initial reconnection delay in milliseconds. Defaults to `250`. */
	initialRetryMs?: number;
}

export interface SseFrame {
	event?: string;
	id?: string;
	data: string;
}

export async function* streamRunEvents(
	http: HttpClient,
	runId: string,
	options: RunStreamOptions = {},
): AsyncIterable<FlueEvent> {
	let lastEventId = options.lastEventId;
	let attempt = 0;
	const maxRetries = options.maxRetries ?? 3;
	const initialRetryMs = options.initialRetryMs ?? 250;

	while (!options.signal?.aborted) {
		try {
			const headers = await http.requestHeaders(
				{
					accept: 'text/event-stream',
					...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}),
				},
				false,
			);
			const response = await http.fetchImpl(http.url(`/runs/${encodeURIComponent(runId)}/stream`), {
				headers,
				signal: options.signal,
			});
			if (!response.ok) throw new Error(`Stream request failed with HTTP ${response.status}.`);
			if (!response.body) throw new Error('Stream response has no body.');

			for await (const frame of readSse(response.body)) {
				if (frame.id !== undefined && /^\d+$/.test(frame.id)) {
					const parsed = Number(frame.id);
					if (Number.isSafeInteger(parsed)) lastEventId = parsed;
				}
				if (frame.event === 'error') throw new Error(parseSseErrorMessage(frame.data));
				const event = JSON.parse(frame.data) as FlueEvent;
				yield event;
				if (event.type === 'run_end') return;
			}
			if (options.signal?.aborted) return;
			if (attempt >= maxRetries) {
				throw new Error('SSE stream closed before run_end.');
			}
			await sleep(initialRetryMs * 2 ** attempt, options.signal);
			attempt++;
		} catch (error) {
			if (options.signal?.aborted) return;
			if (attempt >= maxRetries) throw error;
			await sleep(initialRetryMs * 2 ** attempt, options.signal);
			attempt++;
		}
	}
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = findFrameBoundary(buffer);
			while (boundary) {
				const raw = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const frame = parseFrame(raw);
				if (frame) yield frame;
				boundary = findFrameBoundary(buffer);
			}
		}
		buffer += decoder.decode();
		const frame = parseFrame(buffer);
		if (frame) yield frame;
	} finally {
		try {
			await reader.cancel();
		} catch {}
		reader.releaseLock();
	}
}

function findFrameBoundary(buffer: string): { index: number; length: number } | undefined {
	const candidates = [
		{ index: buffer.indexOf('\r\n\r\n'), length: 4 },
		{ index: buffer.indexOf('\n\n'), length: 2 },
		{ index: buffer.indexOf('\r\r'), length: 2 },
	].filter((candidate) => candidate.index !== -1);

	return candidates.sort((a, b) => a.index - b.index)[0];
}

function parseFrame(raw: string): SseFrame | undefined {
	if (!raw.trim() || raw.startsWith(':')) return undefined;
	const frame: SseFrame = { data: '' };
	const data: string[] = [];
	for (const line of raw.split(/\r\n|\n|\r/)) {
		if (line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
		if (field === 'event') frame.event = value;
		else if (field === 'id') frame.id = value;
		else if (field === 'data') data.push(value);
	}
	if (data.length === 0) return undefined;
	frame.data = data.join('\n');
	return frame;
}

function parseSseErrorMessage(data: string): string {
	try {
		const value = JSON.parse(data) as unknown;
		if (typeof value !== 'object' || value === null || !('error' in value)) throw new Error();
		const error = value.error;
		if (
			typeof error !== 'object' ||
			error === null ||
			!('type' in error) ||
			typeof error.type !== 'string' ||
			!('message' in error) ||
			typeof error.message !== 'string' ||
			!('details' in error) ||
			typeof error.details !== 'string'
		)
			throw new Error();
		return error.message;
	} catch {
		return 'SSE stream failed.';
	}
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(timeout);
					reject(signal.reason ?? new Error('aborted'));
				},
				{ once: true },
			);
		}
	});
}
