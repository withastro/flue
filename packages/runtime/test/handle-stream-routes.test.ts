import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteEventStreamStore } from '../src/runtime/event-stream-store.ts';
import { handleStreamHead, handleStreamRead } from '../src/runtime/handle-stream-routes.ts';

function createStore() {
	const db = new DatabaseSync(':memory:');
	const store = new SqliteEventStreamStore({
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			if (/^\s*(SELECT|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
				return { toArray: () => stmt.all(...(bindings as never[])) as Record<string, unknown>[] };
			}
			stmt.run(...(bindings as never[]));
			return { toArray: () => [] as Record<string, unknown>[] };
		},
	});
	return store;
}

/** Parse an SSE body into ordered frames, skipping comment-only blocks. */
function parseSseFrames(body: string): Array<{ event: string; data: string }> {
	return body
		.split('\n\n')
		.map((block) => block.trim())
		.filter((block) => block !== '' && !block.startsWith(':'))
		.map((block) => {
			const lines = block.split('\n');
			const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
			const data = lines
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice('data:'.length))
				.join('\n');
			return { event, data };
		});
}

describe('handleStreamRead()', () => {
	it('rejects live reads without an offset', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?live=long-poll'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'invalid_request',
		);
	});

	it('rejects duplicate offset parameters', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1&offset=now'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'invalid_request',
		);
	});

	it('returns only the requested trailing events when tail modifies offset=-1', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		for (let index = 0; index < 105; index++) await store.appendEvent('runs/test', { index });

		const first = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1&tail=3'),
		});

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual([{ index: 102 }, { index: 103 }, { index: 104 }]);
		expect(first.headers.get('stream-up-to-date')).toBe('true');
	});

	it('clamps tail to full history when it exceeds the stream length or the stream is empty', async () => {
		const store = createStore();
		await store.createStream('runs/full');
		await store.appendEvent('runs/full', { index: 0 });
		await store.appendEvent('runs/full', { index: 1 });
		await store.createStream('runs/empty');

		const full = await handleStreamRead({
			store,
			path: 'runs/full',
			request: new Request('http://localhost/runs/full?tail=9007199254740991'),
		});
		const empty = await handleStreamRead({
			store,
			path: 'runs/empty',
			request: new Request('http://localhost/runs/empty?tail=5'),
		});

		expect(await full.json()).toEqual([{ index: 0 }, { index: 1 }]);
		expect(await empty.json()).toEqual([]);
		expect(empty.headers.get('stream-next-offset')).toBe('-1');
	});

	it('ignores tail with concrete and now offsets', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		const firstOffset = await store.appendEvent('runs/test', { index: 0 });
		await store.appendEvent('runs/test', { index: 1 });
		await store.appendEvent('runs/test', { index: 2 });

		const concrete = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request(`http://localhost/runs/test?offset=${firstOffset}&tail=1`),
		});
		const now = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=now&tail=1'),
		});

		expect(await concrete.json()).toEqual([{ index: 1 }, { index: 2 }]);
		expect(await now.json()).toEqual([]);
	});

	it('rejects invalid and duplicate tail parameters', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		for (const query of ['tail=0', 'tail=-1', 'tail=1.5', 'tail=abc', 'tail=1&tail=2']) {
			const response = await handleStreamRead({
				store,
				path: 'runs/test',
				request: new Request(`http://localhost/runs/test?${query}`),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
				'invalid_request',
			);
		}
	});

	it('applies tail to the initial read in long-poll and SSE live modes', async () => {
		const store = createStore();
		await store.createStream('runs/long-poll');
		await store.appendEvent('runs/long-poll', { index: 0 });
		await store.appendEvent('runs/long-poll', { index: 1 });
		await store.createStream('runs/sse');
		await store.appendEvent('runs/sse', { index: 0 });
		await store.appendEvent('runs/sse', { index: 1 });
		await store.closeStream('runs/sse');

		const longPoll = await handleStreamRead({
			store,
			path: 'runs/long-poll',
			request: new Request('http://localhost/runs/long-poll?offset=-1&tail=1&live=long-poll'),
		});
		const sse = await handleStreamRead({
			store,
			path: 'runs/sse',
			request: new Request('http://localhost/runs/sse?offset=-1&tail=1&live=sse'),
		});
		const frames = parseSseFrames(await sse.text());

		expect(await longPoll.json()).toEqual([{ index: 1 }]);
		expect(frames).toHaveLength(2);
		const [dataFrame] = frames;
		if (!dataFrame) throw new Error('Expected an SSE data frame.');
		expect(JSON.parse(dataFrame.data)).toEqual([{ index: 1 }]);
	});

	it('omits ETag for offset=now catch-up reads', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		await store.appendEvent('runs/test', { type: 'log' });

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=now'),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toBeNull();
	});

	it('marks an exactly-limit catch-up read as up to date at the tail', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		for (let index = 0; index < 100; index++) {
			await store.appendEvent('runs/test', { index });
		}

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1'),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('stream-up-to-date')).toBe('true');
	});

	it('returns appended data from offset=now long-poll reads', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		const request = new Request('http://localhost/runs/test?offset=now&live=long-poll');
		const responsePromise = handleStreamRead({ store, path: 'runs/test', request });
		await Promise.resolve();
		await store.appendEvent('runs/test', { type: 'log' });

		const response = await responsePromise;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ type: 'log' }]);
	});

	it('rejects malformed offset values with a canonical error envelope', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=banana'),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details: 'Invalid offset format.',
			},
		});
	});

	it('labels missing run streams run_not_found and missing agent streams stream_not_found', async () => {
		const store = createStore();

		const runResponse = await handleStreamRead({
			store,
			path: 'runs/missing-run',
			request: new Request('http://localhost/runs/missing-run?offset=-1'),
		});
		const agentResponse = await handleStreamRead({
			store,
			path: 'agents/assistant/missing-instance',
			request: new Request('http://localhost/agents/assistant/missing-instance?offset=-1'),
		});

		expect(runResponse.status).toBe(404);
		expect(((await runResponse.json()) as { error: { type: string } }).error.type).toBe(
			'run_not_found',
		);
		expect(agentResponse.status).toBe(404);
		expect(((await agentResponse.json()) as { error: { type: string } }).error.type).toBe(
			'stream_not_found',
		);
	});

	it('replays a catch-up read as a 304 when If-None-Match matches the ETag', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		await store.appendEvent('runs/test', { type: 'log' });

		const first = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1'),
		});
		expect(first.status).toBe(200);
		const etag = first.headers.get('etag');
		expect(etag).toBeTruthy();
		if (!etag) throw new Error('Expected an ETag header.');

		const replay = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1', {
				headers: { 'if-none-match': etag },
			}),
		});

		expect(replay.status).toBe(304);
		expect(await replay.text()).toBe('');
		expect(replay.headers.get('etag')).toBe(etag);

		// offset=now reads are uncacheable — no ETag.
		const nowRead = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=now'),
		});
		expect(nowRead.headers.get('etag')).toBeNull();
	});

	it('returns an immediate 204 for a tail long-poll on a closed stream', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		const tail = await store.appendEvent('runs/test', { type: 'log' });
		await store.closeStream('runs/test');

		const started = Date.now();
		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request(`http://localhost/runs/test?offset=${tail}&live=long-poll`),
		});

		// Closed-at-tail must resolve immediately, not hang for the 30s timeout.
		expect(Date.now() - started).toBeLessThan(1000);
		expect(response.status).toBe(204);
		expect(response.headers.get('stream-closed')).toBe('true');
		expect(response.headers.get('stream-up-to-date')).toBe('true');
	});

	it('wakes a tail long-poll when a new event is appended', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		const tail = await store.appendEvent('runs/test', { n: 1 });

		const responsePromise = handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request(`http://localhost/runs/test?offset=${tail}&live=long-poll`),
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		await store.appendEvent('runs/test', { n: 2 });

		const response = await responsePromise;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ n: 2 }]);
		expect(response.headers.get('stream-next-offset')).toMatch(/^\d{16}_\d{16}$/);
	});

	it('frames SSE data and control events and ends the body on a closed stream', async () => {
		const store = createStore();
		await store.createStream('runs/test');
		await store.appendEvent('runs/test', { n: 1 });
		const lastOffset = await store.appendEvent('runs/test', { n: 2 });
		await store.closeStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1&live=sse'),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream');

		// text() only resolves because closure terminates the SSE loop.
		const body = await response.text();
		const frames = parseSseFrames(body);

		expect(frames.map((frame) => frame.event)).toEqual(['data', 'control']);
		const [dataFrame, controlFrame] = frames;
		if (!dataFrame || !controlFrame) throw new Error('Expected SSE data and control frames.');
		expect(JSON.parse(dataFrame.data)).toEqual([{ n: 1 }, { n: 2 }]);
		expect(JSON.parse(controlFrame.data)).toEqual({
			streamNextOffset: lastOffset,
			streamClosed: true,
		});
	});

	it('rejects SSE reads without an offset', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?live=sse'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'invalid_request',
		);
	});

	it('returns 404 for SSE reads on a missing stream', async () => {
		const store = createStore();

		const response = await handleStreamRead({
			store,
			path: 'runs/missing',
			request: new Request('http://localhost/runs/missing?offset=-1&live=sse'),
		});

		expect(response.status).toBe(404);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'run_not_found',
		);
	});

	it('includes browser security headers on read responses', async () => {
		const store = createStore();
		await store.createStream('runs/test');

		const response = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1'),
		});
		const head = await handleStreamHead(store, 'runs/test');

		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(head.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
	});
});
