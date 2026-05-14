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

describe('createRegistryOps (SQL paths)', () => {
	it('round-trips a pointer through recordRunStart + lookupRun', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({
			runId: 'run_01',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_1,
		});
		expect(ops.lookupRun('run_01')).toEqual({
			runId: 'run_01',
			agentName: 'hello',
			instanceId: 'inst_a',
			status: 'active',
			startedAt: STARTED_AT_1,
			endedAt: undefined,
			durationMs: undefined,
			isError: undefined,
		});
		expect(ops.lookupRun('run_does_not_exist')).toBeNull();
	});

	it('records terminal state (status, endedAt, durationMs, isError) via recordRunEnd', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({
			runId: 'run_02',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_1,
		});
		ops.recordRunEnd({
			runId: 'run_02',
			endedAt: ENDED_AT,
			durationMs: 12345,
			isError: false,
		});
		const pointer = ops.lookupRun('run_02');
		assert.ok(pointer);
		expect(pointer.status).toBe('completed');
		expect(pointer.endedAt).toBe(ENDED_AT);
		expect(pointer.durationMs).toBe(12345);
		expect(pointer.isError).toBe(false);
	});

	it('marks status="errored" when recordRunEnd receives isError=true', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({
			runId: 'run_err',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_1,
		});
		ops.recordRunEnd({
			runId: 'run_err',
			endedAt: ENDED_AT,
			durationMs: 1,
			isError: true,
		});
		const pointer = ops.lookupRun('run_err');
		assert.ok(pointer);
		expect(pointer.status).toBe('errored');
		expect(pointer.isError).toBe(true);
	});

	it('silently drops recordRunEnd without a prior start', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunEnd({
			runId: 'orphan',
			endedAt: ENDED_AT,
			durationMs: 0,
			isError: false,
		});
		expect(ops.lookupRun('orphan')).toBeNull();
	});

	it('listRuns: descending sort by startedAt; filters compose', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({ runId: 'a', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
		ops.recordRunStart({ runId: 'b', agentName: 'hello', instanceId: 'inst_b', startedAt: STARTED_AT_2 });
		ops.recordRunStart({ runId: 'c', agentName: 'world', instanceId: 'inst_c', startedAt: STARTED_AT_3 });
		ops.recordRunEnd({ runId: 'a', endedAt: ENDED_AT, durationMs: 1, isError: false });

		expect(ops.listRuns({}).runs.map((r) => r.runId)).toEqual(['c', 'b', 'a']);
		expect(ops.listRuns({ agentName: 'hello' }).runs.map((r) => r.runId)).toEqual(['b', 'a']);
		expect(ops.listRuns({ status: 'active' }).runs.map((r) => r.runId)).toEqual(['c', 'b']);
		expect(
			ops.listRuns({ agentName: 'hello', status: 'completed' }).runs.map((r) => r.runId),
		).toEqual(['a']);
		expect(ops.listRuns({ instanceId: 'inst_b' }).runs.map((r) => r.runId)).toEqual(['b']);
	});

	it('listRuns cursor pagination: page1 + nextCursor → page2 → final', () => {
		const ops = createRegistryOps(makeFakeSql());
		for (let i = 0; i < 5; i++) {
			ops.recordRunStart({
				runId: `run_${String(i).padStart(2, '0')}`,
				agentName: 'hello',
				instanceId: 'inst_a',
				startedAt: `2026-05-13T10:${String(i).padStart(2, '0')}:00.000Z`,
			});
		}
		const page1 = ops.listRuns({ limit: 2 });
		expect(page1.runs.map((r) => r.runId)).toEqual(['run_04', 'run_03']);
		assert.ok(page1.nextCursor);

		const page2 = ops.listRuns({ limit: 2, cursor: page1.nextCursor });
		expect(page2.runs.map((r) => r.runId)).toEqual(['run_02', 'run_01']);
		assert.ok(page2.nextCursor);

		const page3 = ops.listRuns({ limit: 2, cursor: page2.nextCursor });
		expect(page3.runs.map((r) => r.runId)).toEqual(['run_00']);
		expect(page3.nextCursor).toBeUndefined();
	});

	it('listInstances: distinct (agent, instance) pairs; agent filter', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({ runId: 'r1', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
		ops.recordRunStart({ runId: 'r2', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_2 });
		ops.recordRunStart({ runId: 'r3', agentName: 'hello', instanceId: 'inst_b', startedAt: STARTED_AT_3 });
		ops.recordRunStart({ runId: 'r4', agentName: 'world', instanceId: 'inst_c', startedAt: STARTED_AT_3 });

		expect(ops.listInstances({}).instances).toEqual([
			{ agentName: 'hello', instanceId: 'inst_a' },
			{ agentName: 'hello', instanceId: 'inst_b' },
			{ agentName: 'world', instanceId: 'inst_c' },
		]);
		expect(ops.listInstances({ agentName: 'hello' }).instances).toEqual([
			{ agentName: 'hello', instanceId: 'inst_a' },
			{ agentName: 'hello', instanceId: 'inst_b' },
		]);
	});

	it('listInstances cursor pagination: walks through pairs; final page has no nextCursor', () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({ runId: 'r1', agentName: 'a', instanceId: 'inst_1', startedAt: STARTED_AT_1 });
		ops.recordRunStart({ runId: 'r2', agentName: 'a', instanceId: 'inst_2', startedAt: STARTED_AT_2 });
		ops.recordRunStart({ runId: 'r3', agentName: 'b', instanceId: 'inst_3', startedAt: STARTED_AT_3 });

		const page1 = ops.listInstances({ limit: 1 });
		expect(page1.instances).toHaveLength(1);
		assert.ok(page1.nextCursor);
		const page2 = ops.listInstances({ limit: 1, cursor: page1.nextCursor });
		expect(page2.instances).toHaveLength(1);
		assert.ok(page2.nextCursor);
		const page3 = ops.listInstances({ limit: 1, cursor: page2.nextCursor });
		expect(page3.instances).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
	});

	it('malformed cursor: falls back to page 1, not empty, not error', () => {
		const ops = createRegistryOps(makeFakeSql());
		for (let i = 0; i < 3; i++) {
			ops.recordRunStart({
				runId: `run_${i}`,
				agentName: 'hello',
				instanceId: 'a',
				startedAt: `2026-01-01T00:00:0${i}.000Z`,
			});
		}
		expect(ops.listRuns({ cursor: 'not-valid-base64-json' }).runs).toHaveLength(3);
		expect(ops.listInstances({ cursor: 'also-garbage' }).instances).toHaveLength(1);
	});

	it('pruning: per-instance cap drops oldest completed; active runs kept', () => {
		const ops = createRegistryOps(makeFakeSql(), { maxCompletedRunsPerInstance: 2 });
		for (let i = 0; i < 3; i++) {
			const runId = `done_${i}`;
			ops.recordRunStart({
				runId,
				agentName: 'hello',
				instanceId: 'inst_a',
				startedAt: `2026-05-13T10:0${i}:00.000Z`,
			});
			ops.recordRunEnd({
				runId,
				endedAt: `2026-05-13T10:0${i + 1}:00.000Z`,
				durationMs: 60_000,
				isError: false,
			});
		}
		ops.recordRunStart({
			runId: 'still_running',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_3,
		});

		expect(ops.lookupRun('done_0')).toBeNull();
		expect(ops.lookupRun('done_1')).not.toBeNull();
		expect(ops.lookupRun('done_2')).not.toBeNull();
		expect(ops.lookupRun('still_running')).not.toBeNull();
		expect(ops.listRuns({}).runs).toHaveLength(3);
	});

	it('pruning: separate instances retain separate completed buckets', () => {
		const ops = createRegistryOps(makeFakeSql(), { maxCompletedRunsPerInstance: 2 });
		for (const instanceId of ['inst_a', 'inst_b']) {
			for (let i = 0; i < 2; i++) {
				const runId = `${instanceId}_${i}`;
				ops.recordRunStart({
					runId,
					agentName: 'hello',
					instanceId,
					startedAt: `2026-05-13T10:0${instanceId === 'inst_a' ? 1 : 2}:${i}0.000Z`,
				});
				ops.recordRunEnd({
					runId,
					endedAt: `2026-05-13T10:0${instanceId === 'inst_a' ? 1 : 2}:${i}5.000Z`,
					durationMs: 5_000,
					isError: false,
				});
			}
		}

		expect(ops.listRuns({ agentName: 'hello' }).runs).toHaveLength(4);
		expect(ops.lookupRun('inst_a_0')).not.toBeNull();
		expect(ops.lookupRun('inst_b_0')).not.toBeNull();
	});
});

describe('handleRegistryRequest (REST router)', () => {
	it('GET /pointers/<runId>: 200 + body for hit, 404 for miss', async () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({
			runId: 'run_rest_01',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_1,
		});

		const hit = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers/run_rest_01', { method: 'GET' }),
		);
		expect(hit.status).toBe(200);
		expect(((await hit.json()) as { runId: string }).runId).toBe('run_rest_01');

		const miss = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers/nope', { method: 'GET' }),
		);
		expect(miss.status).toBe(404);
	});

	it('POST /pointers/<runId>/start: 204 and pointer is now lookup-able', async () => {
		const ops = createRegistryOps(makeFakeSql());
		const res = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers/run_rest_start/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agentName: 'hello',
					instanceId: 'inst_a',
					startedAt: STARTED_AT_1,
				}),
			}),
		);
		expect(res.status).toBe(204);
		expect(ops.lookupRun('run_rest_start')?.status).toBe('active');
	});

	it('POST /pointers/<runId>/end: 204 and pointer status is updated', async () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({
			runId: 'run_rest_end',
			agentName: 'hello',
			instanceId: 'inst_a',
			startedAt: STARTED_AT_1,
		});
		const res = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers/run_rest_end/end', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ endedAt: ENDED_AT, durationMs: 5000, isError: false }),
			}),
		);
		expect(res.status).toBe(204);
		const pointer = ops.lookupRun('run_rest_end');
		expect(pointer?.status).toBe('completed');
		expect(pointer?.endedAt).toBe(ENDED_AT);
	});

	it('GET /pointers (list) and /instances respond JSON; honor query params', async () => {
		const ops = createRegistryOps(makeFakeSql());
		ops.recordRunStart({ runId: 'L1', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
		ops.recordRunStart({ runId: 'L2', agentName: 'world', instanceId: 'inst_b', startedAt: STARTED_AT_2 });

		const listAll = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers', { method: 'GET' }),
		);
		expect(((await listAll.json()) as { runs: unknown[] }).runs).toHaveLength(2);

		const listFiltered = await handleRegistryRequest(
			ops,
			new Request('https://registry/pointers?agent=hello', { method: 'GET' }),
		);
		expect(
			((await listFiltered.json()) as { runs: { runId: string }[] }).runs.map((r) => r.runId),
		).toEqual(['L1']);

		const instances = await handleRegistryRequest(
			ops,
			new Request('https://registry/instances?agent=hello', { method: 'GET' }),
		);
		expect(
			((await instances.json()) as { instances: unknown[] }).instances,
		).toEqual([{ agentName: 'hello', instanceId: 'inst_a' }]);
	});

	it('unknown route: 404', async () => {
		const ops = createRegistryOps(makeFakeSql());
		const res = await handleRegistryRequest(
			ops,
			new Request('https://registry/whatever', { method: 'GET' }),
		);
		expect(res.status).toBe(404);
	});
});
