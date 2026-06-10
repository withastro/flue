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
		expect((await response.json() as { error: { type: string } }).error.type).toBe('invalid_request');
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
		expect((await response.json() as { error: { type: string } }).error.type).toBe('invalid_request');
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
		expect((await runResponse.json() as { error: { type: string } }).error.type).toBe('run_not_found');
		expect(agentResponse.status).toBe(404);
		expect((await agentResponse.json() as { error: { type: string } }).error.type).toBe('stream_not_found');
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

		const replay = await handleStreamRead({
			store,
			path: 'runs/test',
			request: new Request('http://localhost/runs/test?offset=-1', {
				headers: { 'if-none-match': etag! },
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
		expect(JSON.parse(frames[0]!.data)).toEqual([{ n: 1 }, { n: 2 }]);
		expect(JSON.parse(frames[1]!.data)).toEqual({
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
		expect((await response.json() as { error: { type: string } }).error.type).toBe('invalid_request');
	});

	it('returns 404 for SSE reads on a missing stream', async () => {
		const store = createStore();

		const response = await handleStreamRead({
			store,
			path: 'runs/missing',
			request: new Request('http://localhost/runs/missing?offset=-1&live=sse'),
		});

		expect(response.status).toBe(404);
		expect((await response.json() as { error: { type: string } }).error.type).toBe('run_not_found');
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
