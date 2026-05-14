import type { HttpClient } from '../http.ts';
import type { FlueEvent } from '../types.ts';

export interface StreamOptions {
	lastEventId?: number;
	signal?: AbortSignal;
	maxRetries?: number;
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
	options: StreamOptions = {},
): AsyncIterable<FlueEvent> {
	let lastEventId = options.lastEventId;
	let attempt = 0;
	const maxRetries = options.maxRetries ?? 3;
	const initialRetryMs = options.initialRetryMs ?? 250;

	while (!options.signal?.aborted) {
		try {
			let sawTerminalEvent = false;
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
				if (frame.id !== undefined) {
					const parsed = Number.parseInt(frame.id, 10);
					if (Number.isFinite(parsed)) lastEventId = parsed;
				}
				const event = JSON.parse(frame.data) as FlueEvent;
				yield event;
				if (event.type === 'run_end') {
					sawTerminalEvent = true;
					return;
				}
			}
			if (sawTerminalEvent || options.signal?.aborted) return;
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
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
			let idx = buffer.indexOf('\n\n');
			while (idx !== -1) {
				const raw = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const frame = parseFrame(raw);
				if (frame) yield frame;
				idx = buffer.indexOf('\n\n');
			}
		}
		buffer += decoder.decode().replace(/\r\n/g, '\n');
		const frame = parseFrame(buffer);
		if (frame) yield frame;
	} finally {
		reader.releaseLock();
	}
}

function parseFrame(raw: string): SseFrame | undefined {
	if (!raw.trim() || raw.startsWith(':')) return undefined;
	const frame: SseFrame = { data: '' };
	const data: string[] = [];
	for (const line of raw.split('\n')) {
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
