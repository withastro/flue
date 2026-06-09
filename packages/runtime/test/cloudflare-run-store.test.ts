import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vite-plus/test';
import { createDurableRunStore } from '../src/cloudflare/run-store.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				let rows: unknown[];
				const trimmed = query.trimStart().toUpperCase();
				const expectsRows =
					trimmed.startsWith('SELECT') ||
					trimmed.startsWith('WITH') ||
					/\bRETURNING\b/i.test(query);
				if (expectsRows) {
					rows = stmt.all(...(bindings as never[]));
				} else {
					stmt.run(...(bindings as never[]));
					rows = [];
				}
				return {
					toArray() {
						return rows as Record<string, unknown>[];
					},
				};
			},
		},
	};
}

function owner(runId: string) {
	return { kind: 'workflow' as const, workflowName: 'hello', instanceId: runId };
}

describe('createDurableRunStore()', () => {
	it('ignores an event when appendEvent() receives an unknown run id', async () => {
		const { db, sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:unknown';

		await store.appendEvent(runId, {
			type: 'log',
			level: 'info',
			message: 'stale event',
			runId,
			eventIndex: 0,
		});

		expect(db.prepare('SELECT * FROM flue_run_events WHERE run_id = ?').all(runId)).toEqual([]);
	});

	it('rejects duplicate workflow event indexes when events are appended', async () => {
		const { sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:duplicate';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
		});
		await store.appendEvent(runId, {
			type: 'log',
			level: 'info',
			message: 'first',
			runId,
			eventIndex: 0,
		});

		await expect(
			store.appendEvent(runId, {
				type: 'log',
				level: 'info',
				message: 'replacement',
				runId,
				eventIndex: 0,
			}),
		).rejects.toThrow('UNIQUE constraint failed');
		expect(await store.getEvents(runId)).toMatchObject([{ message: 'first' }]);
	});

	it('rejects malformed workflow events when persistence identity is missing or mismatched', async () => {
		const { sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:malformed';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
		});

		await expect(
			store.appendEvent(runId, {
				type: 'log',
				level: 'info',
				message: 'missing index',
				runId,
			}),
		).rejects.toThrow('index must be a non-negative integer');
		await expect(
			store.appendEvent(runId, {
				type: 'log',
				level: 'info',
				message: 'wrong run',
				runId: 'workflow:hello:other',
				eventIndex: 0,
			}),
		).rejects.toThrow('runId does not match its run');
	});

	it('clears prior event history when createRun() initializes an existing run id', async () => {
		const { sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:reused';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
		});
		await store.appendEvent(runId, {
			type: 'log',
			level: 'info',
			message: 'stale event',
			runId,
			eventIndex: 0,
		});

		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:01.000Z',
			payload: {},
		});

		expect(await store.getEvents(runId)).toEqual([]);
	});

	it('preserves absent optional fields when run persistence receives undefined values', async () => {
		const { sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:absent';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: undefined,
		});
		await store.endRun({
			runId,
			endedAt: '2026-06-02T00:00:01.000Z',
			isError: false,
			durationMs: 1000,
		});

		expect(await store.getRun(runId)).toMatchObject({
			payload: undefined,
			result: undefined,
			error: undefined,
		});
	});

	it('preserves explicit null values when run persistence receives null', async () => {
		const { sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:null';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: null,
		});
		await store.endRun({
			runId,
			endedAt: '2026-06-02T00:00:01.000Z',
			isError: false,
			durationMs: 1000,
			result: null,
			error: null,
		});

		expect(await store.getRun(runId)).toMatchObject({ payload: null, result: null, error: null });
	});
});
