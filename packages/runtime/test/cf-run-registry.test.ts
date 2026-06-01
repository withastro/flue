import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createRegistryOps,
	handleRegistryRequest,
	type SqlStorage,
} from '../src/cloudflare/registry-ops.ts';

function makeFakeSql(): SqlStorage {
	const db = new DatabaseSync(':memory:');
	return {
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
	};
}

const STARTED_AT_1 = '2026-05-13T10:00:00.000Z';
const STARTED_AT_2 = '2026-05-13T10:01:00.000Z';
const STARTED_AT_3 = '2026-05-13T10:02:00.000Z';
const ENDED_AT = '2026-05-13T10:03:00.000Z';

function owner(workflowName: string, runId: string) {
	return { kind: 'workflow' as const, workflowName, instanceId: runId };
}

describe('createRegistryOps (SQL paths)', () => {
	it('round-trips a workflow pointer through recordRunStart and lookupRun', () => {
		const sql = makeFakeSql();
		const ops = createRegistryOps(sql);
		const runId = 'workflow:hello:01';
		ops.recordRunStart({ runId, owner: owner('hello', runId), startedAt: STARTED_AT_1 });
		expect(ops.lookupRun(runId)).toEqual({
			runId,
			owner: owner('hello', runId),
			status: 'active',
			startedAt: STARTED_AT_1,
			endedAt: undefined,
			durationMs: undefined,
			isError: undefined,
		});
		expect(ops.lookupRun('workflow:hello:missing')).toBeNull();
		expect(
			sql
				.exec('PRAGMA table_info(flue_registry_runs)')
				.toArray()
				.map((row) => row.name),
		).not.toContain('agent_name');
	});

	it('records terminal state for workflow pointers', () => {
		const ops = createRegistryOps(makeFakeSql());
		const runId = 'workflow:hello:02';
		ops.recordRunStart({ runId, owner: owner('hello', runId), startedAt: STARTED_AT_1 });
		ops.recordRunEnd({ runId, endedAt: ENDED_AT, durationMs: 12345, isError: false });
		const pointer = ops.lookupRun(runId);
		assert.ok(pointer);
		expect(pointer).toMatchObject({
			status: 'completed',
			endedAt: ENDED_AT,
			durationMs: 12345,
			isError: false,
		});
	});

	it('marks errored workflow pointers', () => {
		const ops = createRegistryOps(makeFakeSql());
		const runId = 'workflow:hello:error';
		ops.recordRunStart({ runId, owner: owner('hello', runId), startedAt: STARTED_AT_1 });
		ops.recordRunEnd({ runId, endedAt: ENDED_AT, durationMs: 1, isError: true });
		expect(ops.lookupRun(runId)).toMatchObject({ status: 'errored', isError: true });
	});

	it('silently drops terminal updates without a prior workflow start', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunEnd({
			runId: 'workflow:hello:orphan',
			endedAt: ENDED_AT,
			durationMs: 0,
			isError: false,
		});
		expect(ops.lookupRun('workflow:hello:orphan')).toBeNull();
	});

	it('sorts workflow runs descending and composes workflow filters', () => {
		const ops = createRegistryOps(makeFakeSql());
		for (const [runId, workflowName, startedAt] of [
			['workflow:hello:a', 'hello', STARTED_AT_1],
			['workflow:hello:b', 'hello', STARTED_AT_2],
			['workflow:world:c', 'world', STARTED_AT_3],
		] as const) {
			ops.recordRunStart({ runId, owner: owner(workflowName, runId), startedAt });
		}
		ops.recordRunEnd({
			runId: 'workflow:hello:a',
			endedAt: ENDED_AT,
			durationMs: 1,
			isError: false,
		});
		expect(ops.listRuns({}).runs.map((run) => run.runId)).toEqual([
			'workflow:world:c',
			'workflow:hello:b',
			'workflow:hello:a',
		]);
		expect(ops.listRuns({ workflowName: 'hello' }).runs.map((run) => run.runId)).toEqual([
			'workflow:hello:b',
			'workflow:hello:a',
		]);
		expect(ops.listRuns({ status: 'active' }).runs.map((run) => run.runId)).toEqual([
			'workflow:world:c',
			'workflow:hello:b',
		]);
		expect(
			ops.listRuns({ workflowName: 'hello', status: 'completed' }).runs.map((run) => run.runId),
		).toEqual(['workflow:hello:a']);
	});

	it('paginates workflow run pointers', () => {
		const ops = createRegistryOps(makeFakeSql());
		for (let i = 0; i < 5; i++) {
			const runId = `workflow:hello:${String(i).padStart(2, '0')}`;
			ops.recordRunStart({
				runId,
				owner: owner('hello', runId),
				startedAt: `2026-05-13T10:${String(i).padStart(2, '0')}:00.000Z`,
			});
		}
		const page1 = ops.listRuns({ limit: 2 });
		const page2 = ops.listRuns({ limit: 2, cursor: page1.nextCursor });
		const page3 = ops.listRuns({ limit: 2, cursor: page2.nextCursor });
		expect(page1.runs.map((run) => run.runId)).toEqual(['workflow:hello:04', 'workflow:hello:03']);
		expect(page2.runs.map((run) => run.runId)).toEqual(['workflow:hello:02', 'workflow:hello:01']);
		expect(page3.runs.map((run) => run.runId)).toEqual(['workflow:hello:00']);
		expect(page3.nextCursor).toBeUndefined();
	});

	it('rejects workflow owners whose instance id does not match run id', () => {
		const ops = createRegistryOps(makeFakeSql());
		expect(() =>
			ops.recordRunStart({
				runId: 'workflow:daily-report:01A',
				owner: owner('daily-report', 'workflow:daily-report:01B'),
				startedAt: STARTED_AT_1,
			}),
		).toThrow(/same instanceId/);
	});

	it('does not surface historical agent-owned pointer rows', () => {
		const sql = makeFakeSql();
		const ops = createRegistryOps(sql);
		sql.exec(
			`INSERT INTO flue_registry_runs (run_id, owner_kind, instance_id, status, started_at) VALUES (?, 'agent', ?, 'active', ?)`,
			'legacy-agent',
			'inst_a',
			STARTED_AT_1,
		);
		expect(ops.lookupRun('legacy-agent')).toBeNull();
		expect(ops.listRuns({}).runs).toEqual([]);
	});

	it('tolerates inert columns in supported historical tables while admitting new workflows', () => {
		const sql = makeFakeSql();
		sql.exec(`CREATE TABLE flue_registry_runs (
			run_id TEXT PRIMARY KEY,
			owner_kind TEXT NOT NULL,
			agent_name TEXT,
			instance_id TEXT,
			workflow_name TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			duration_ms INTEGER,
			is_error INTEGER
		)`);
		sql.exec(
			`INSERT INTO flue_registry_runs (run_id, owner_kind, agent_name, instance_id, status, started_at) VALUES (?, 'agent', ?, ?, ?, ?)`,
			'historical-agent',
			'hello',
			'inst_a',
			'active',
			STARTED_AT_1,
		);
		const ops = createRegistryOps(sql);
		const runId = 'workflow:hello:current';
		ops.recordRunStart({ runId, owner: owner('hello', runId), startedAt: STARTED_AT_2 });
		expect(ops.lookupRun('historical-agent')).toBeNull();
		expect(ops.lookupRun(runId)).toEqual({
			runId,
			owner: owner('hello', runId),
			status: 'active',
			startedAt: STARTED_AT_2,
			endedAt: undefined,
			durationMs: undefined,
			isError: undefined,
		});
		expect(ops.listRuns({}).runs.map((run) => run.runId)).toEqual([runId]);
	});

	it('falls back to page 1 on a malformed cursor', () => {
		const ops = createRegistryOps(makeFakeSql());
		for (let i = 0; i < 3; i++) {
			const runId = `workflow:hello:${i}`;
			ops.recordRunStart({
				runId,
				owner: owner('hello', runId),
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}
		expect(ops.listRuns({ cursor: 'not-valid-base64-json' }).runs).toHaveLength(3);
	});
});

describe('handleRegistryRequest (REST router)', () => {
	it('gets workflow pointers and returns 404 for missing values', async () => {
		const ops = createRegistryOps(makeFakeSql());
		const runId = 'workflow:hello:rest';
		ops.recordRunStart({ runId, owner: owner('hello', runId), startedAt: STARTED_AT_1 });
		const hit = await handleRegistryRequest(
			ops,
			new Request(`https://registry/pointers/${encodeURIComponent(runId)}`),
		);
		expect(hit.status).toBe(200);
		expect((await hit.json()) as unknown).toMatchObject({ runId });
		const miss = await handleRegistryRequest(ops, new Request('https://registry/pointers/nope'));
		expect(miss.status).toBe(404);
	});

	it('starts and ends encoded workflow pointers through private routes', async () => {
		const ops = createRegistryOps(makeFakeSql());
		const runId = 'workflow:daily-report:run_01';
		const encoded = encodeURIComponent(runId);
		const start = await handleRegistryRequest(
			ops,
			new Request(`https://registry/pointers/${encoded}/start`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ owner: owner('daily-report', runId), startedAt: STARTED_AT_1 }),
			}),
		);
		expect(start.status).toBe(204);
		const end = await handleRegistryRequest(
			ops,
			new Request(`https://registry/pointers/${encoded}/end`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ endedAt: ENDED_AT, durationMs: 5000, isError: true }),
			}),
		);
		expect(end.status).toBe(204);
		const hit = await handleRegistryRequest(
			ops,
			new Request(`https://registry/pointers/${encoded}`),
		);
		expect(await hit.json()).toMatchObject({ runId, status: 'errored' });
	});

	it('lists workflow pointers with workflow query filtering', async () => {
		const ops = createRegistryOps(makeFakeSql());
		for (const name of ['hello', 'world']) {
			const runId = `workflow:${name}:list`;
			ops.recordRunStart({
				runId,
				owner: owner(name, runId),
				startedAt: name === 'hello' ? STARTED_AT_1 : STARTED_AT_2,
			});
		}
		const listFiltered = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers?workflow=hello'),
		);
		expect(
			((await listFiltered.json()) as { runs: { runId: string }[] }).runs.map((run) => run.runId),
		).toEqual(['workflow:hello:list']);
		const removedInstancesRoute = await handleRegistryRequest(
			ops,
			new Request('https://registry/instances'),
		);
		expect(removedInstancesRoute.status).toBe(404);
	});
});
