import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createDurableRunStore } from '../src/cloudflare/run-store.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				let rows: unknown[];
				try {
					rows = stmt.all(...(bindings as never[]));
				} catch {
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

describe('createDurableRunStore', () => {
	it('creates new run tables without retired compatibility columns', async () => {
		const { db, sql } = makeFakeSql();
		const store = createDurableRunStore(sql);
		const runId = 'workflow:hello:fresh';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-05-31T00:00:00.000Z',
			payload: { hello: 'world' },
		});
		await store.endRun({
			runId,
			endedAt: '2026-05-31T00:00:01.000Z',
			isError: false,
			durationMs: 1000,
			result: { ok: true },
		});

		expect(
			db
				.prepare('PRAGMA table_info(flue_runs)')
				.all()
				.map((row) => row.name),
		).not.toEqual(
			expect.arrayContaining([
				'agent_name',
				'owner_run_id',
				'restarted_from_run_id',
				'restarted_as_run_id',
			]),
		);
		expect(await store.getRun(runId)).toMatchObject({
			runId,
			owner: owner(runId),
			status: 'completed',
			payload: { hello: 'world' },
			result: { ok: true },
		});
	});

	it('tolerates inert columns in supported historical tables without surfacing restart linkage', async () => {
		const { db, sql } = makeFakeSql();
		db.exec(`CREATE TABLE flue_runs (
			run_id TEXT PRIMARY KEY,
			owner_kind TEXT NOT NULL,
			instance_id TEXT,
			agent_name TEXT,
			workflow_name TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			payload TEXT,
			restarted_from_run_id TEXT,
			restarted_as_run_id TEXT,
			ended_at TEXT,
			is_error INTEGER,
			duration_ms INTEGER,
			result TEXT,
			error TEXT
		)`);
		db.exec(`INSERT INTO flue_runs (run_id, owner_kind, instance_id, workflow_name, status, started_at, payload, restarted_from_run_id, restarted_as_run_id)
			VALUES ('workflow:hello:historical', 'workflow', NULL, 'hello', 'errored', '2026-05-31T00:00:00.000Z', '{}', 'workflow:hello:before', 'workflow:hello:after')`);

		const store = createDurableRunStore(sql);
		const historical = await store.getRun('workflow:hello:historical');
		expect(historical).toMatchObject({ owner: owner('workflow:hello:historical') });
		expect(historical).not.toHaveProperty('restartedFromRunId');
		expect(historical).not.toHaveProperty('restartedAsRunId');

		const runId = 'workflow:hello:current';
		await store.createRun({
			runId,
			owner: owner(runId),
			startedAt: '2026-05-31T00:00:01.000Z',
			payload: {},
		});
		expect(await store.getRun(runId)).toMatchObject({ runId, owner: owner(runId) });
	});
});
