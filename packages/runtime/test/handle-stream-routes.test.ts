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
