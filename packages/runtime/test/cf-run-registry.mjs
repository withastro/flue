#!/usr/bin/env node
/**
 * Inline test for the Cloudflare-side `FlueRegistry` SQL ops + REST
 * router. Exercises `createRegistryOps(sql)` and `handleRegistryRequest`
 * against a real SQLite (via Node's built-in `node:sqlite`) shimmed
 * into the loose `SqlStorage` shape workerd's DO storage provides —
 * specifically `.exec(query, ...bindings).toArray()`.
 *
 * Why a real SQL engine and not a stub:
 *   - The registry's logic is mostly in SQL (filters, keyset pagination,
 *     prune statement). A stub that pretends to be SQLite while
 *     no-oping the query string would give us false confidence.
 *   - `node:sqlite` ships in Node 22.5+; the repo already requires
 *     Node 22.18 (per packages/runtime/package.json `engines`). No
 *     new dependencies.
 *
 * Coverage:
 *   1. recordRunStart / lookupRun: round-trip a pointer through SQL.
 *   2. recordRunEnd: status update + isError + duration land in the row.
 *   3. listRuns: filter by status / agent / instance; descending sort.
 *   4. listRuns cursor pagination: page 1 + cursor → page 2.
 *   5. listInstances: distinct (agent, instance) pairs; agent filter.
 *   6. Pruning: per-agent cap; active runs never pruned.
 *   7. REST router: handleRegistryRequest covers every method+path.
 *
 * Run from packages/runtime/ after a fresh build:
 *
 *   pnpm run build && node test/cf-run-registry.mjs
 */
// biome-ignore-all lint/suspicious/noConsole: test runner output is its UX
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
	createRegistryOps,
	handleRegistryRequest,
} from '../src/cloudflare/registry-ops.ts';

/**
 * Wrap a `node:sqlite` `DatabaseSync` in the loose `SqlStorage` shape
 * workerd's DO storage exposes. workerd's `sql.exec(query, ...bindings)`
 * returns a result with `.toArray()` returning `Record<string, unknown>[]`.
 * `prepare()` + `.all()` on `DatabaseSync` matches this exactly.
 *
 * One quirk: workerd's `.exec()` accepts positional `?` placeholders
 * via the rest-args after the SQL string. `DatabaseSync` does the same
 * but takes them as a single `all(...args)` array. The shim just
 * forwards.
 */
function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			// SELECT vs INSERT/UPDATE/DELETE differ in whether `.all()`
			// throws ("This statement returns data") or whether `.run()`
			// must be used. The cleanest disambiguator at the workerd
			// shape level: try `.all()` first, fall back to `.run()`.
			let rows;
			try {
				rows = stmt.all(...bindings);
			} catch {
				stmt.run(...bindings);
				rows = [];
			}
			return {
				toArray() {
					return rows;
				},
			};
		},
	};
}

let passed = 0;
const test = async (name, fn) => {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (err) {
		console.error(`  ✗ ${name}`);
		console.error(err);
		process.exit(1);
	}
};

const STARTED_AT_1 = '2026-05-13T10:00:00.000Z';
const STARTED_AT_2 = '2026-05-13T10:01:00.000Z';
const STARTED_AT_3 = '2026-05-13T10:02:00.000Z';
const ENDED_AT = '2026-05-13T10:03:00.000Z';

console.log('createRegistryOps (SQL paths):');

await test('recordRunStart + lookupRun: round-trip a pointer through SQL', async () => {
	const ops = createRegistryOps(makeFakeSql());
	ops.recordRunStart({
		runId: 'run_01',
		agentName: 'hello',
		instanceId: 'inst_a',
		startedAt: STARTED_AT_1,
	});
	const pointer = ops.lookupRun('run_01');
	assert.deepEqual(pointer, {
		runId: 'run_01',
		agentName: 'hello',
		instanceId: 'inst_a',
		status: 'active',
		startedAt: STARTED_AT_1,
		endedAt: undefined,
		durationMs: undefined,
		isError: undefined,
	});
	assert.equal(ops.lookupRun('run_does_not_exist'), null);
});

await test('recordRunEnd: status / endedAt / durationMs / isError land', () => {
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
	assert.equal(pointer.status, 'completed');
	assert.equal(pointer.endedAt, ENDED_AT);
	assert.equal(pointer.durationMs, 12345);
	assert.equal(pointer.isError, false);
});

await test('recordRunEnd with isError=true marks status="errored"', () => {
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
	assert.equal(pointer.status, 'errored');
	assert.equal(pointer.isError, true);
});

await test('recordRunEnd without prior start: silent drop, no row created', () => {
	const ops = createRegistryOps(makeFakeSql());
	ops.recordRunEnd({
		runId: 'orphan',
		endedAt: ENDED_AT,
		durationMs: 0,
		isError: false,
	});
	assert.equal(ops.lookupRun('orphan'), null);
});

await test('listRuns: descending sort by startedAt; filters compose', () => {
	const ops = createRegistryOps(makeFakeSql());
	ops.recordRunStart({ runId: 'a', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
	ops.recordRunStart({ runId: 'b', agentName: 'hello', instanceId: 'inst_b', startedAt: STARTED_AT_2 });
	ops.recordRunStart({ runId: 'c', agentName: 'world', instanceId: 'inst_c', startedAt: STARTED_AT_3 });
	ops.recordRunEnd({ runId: 'a', endedAt: ENDED_AT, durationMs: 1, isError: false });

	const all = ops.listRuns({});
	assert.deepEqual(all.runs.map((r) => r.runId), ['c', 'b', 'a']);

	const onlyHello = ops.listRuns({ agentName: 'hello' });
	assert.deepEqual(onlyHello.runs.map((r) => r.runId), ['b', 'a']);

	const onlyActive = ops.listRuns({ status: 'active' });
	assert.deepEqual(onlyActive.runs.map((r) => r.runId), ['c', 'b']);

	const helloAndCompleted = ops.listRuns({ agentName: 'hello', status: 'completed' });
	assert.deepEqual(helloAndCompleted.runs.map((r) => r.runId), ['a']);

	const onlyInstB = ops.listRuns({ instanceId: 'inst_b' });
	assert.deepEqual(onlyInstB.runs.map((r) => r.runId), ['b']);
});

await test('listRuns cursor pagination: page1 + nextCursor → page2', () => {
	const ops = createRegistryOps(makeFakeSql());
	for (let i = 0; i < 5; i++) {
		ops.recordRunStart({
			runId: `run_${String(i).padStart(2, '0')}`,
			agentName: 'hello',
			instanceId: 'inst_a',
			// Distinct startedAt for each so order is deterministic.
			startedAt: `2026-05-13T10:${String(i).padStart(2, '0')}:00.000Z`,
		});
	}
	const page1 = ops.listRuns({ limit: 2 });
	assert.equal(page1.runs.length, 2);
	assert.deepEqual(page1.runs.map((r) => r.runId), ['run_04', 'run_03']);
	assert.ok(page1.nextCursor, 'page1 should have a nextCursor');

	const page2 = ops.listRuns({ limit: 2, cursor: page1.nextCursor });
	assert.deepEqual(page2.runs.map((r) => r.runId), ['run_02', 'run_01']);
	assert.ok(page2.nextCursor);

	const page3 = ops.listRuns({ limit: 2, cursor: page2.nextCursor });
	assert.deepEqual(page3.runs.map((r) => r.runId), ['run_00']);
	assert.equal(page3.nextCursor, undefined, 'final page has no nextCursor');
});

await test('listInstances: distinct (agent, instance) pairs; agent filter', () => {
	const ops = createRegistryOps(makeFakeSql());
	// Two runs for (hello, inst_a) — should dedupe to one instance row.
	ops.recordRunStart({ runId: 'r1', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
	ops.recordRunStart({ runId: 'r2', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_2 });
	ops.recordRunStart({ runId: 'r3', agentName: 'hello', instanceId: 'inst_b', startedAt: STARTED_AT_3 });
	ops.recordRunStart({ runId: 'r4', agentName: 'world', instanceId: 'inst_c', startedAt: STARTED_AT_3 });

	const all = ops.listInstances({});
	assert.deepEqual(all.instances, [
		{ agentName: 'hello', instanceId: 'inst_a' },
		{ agentName: 'hello', instanceId: 'inst_b' },
		{ agentName: 'world', instanceId: 'inst_c' },
	]);

	const helloOnly = ops.listInstances({ agentName: 'hello' });
	assert.deepEqual(helloOnly.instances, [
		{ agentName: 'hello', instanceId: 'inst_a' },
		{ agentName: 'hello', instanceId: 'inst_b' },
	]);
});

await test('pruning: per-agent cap drops oldest completed; active runs are kept', () => {
	const ops = createRegistryOps(makeFakeSql(), { maxCompletedRunsPerAgent: 2 });
	// Three completed for 'hello' + one active = 4 total. After pruning,
	// the oldest completed should be gone; the active is kept regardless.
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

	// `done_0` is the oldest completed; the cap is 2, so it should
	// be gone after the third recordRunEnd's prune.
	assert.equal(ops.lookupRun('done_0'), null, 'oldest completed should be pruned');
	assert.ok(ops.lookupRun('done_1'), 'second-oldest completed should remain');
	assert.ok(ops.lookupRun('done_2'), 'newest completed should remain');
	assert.ok(ops.lookupRun('still_running'), 'active run is never pruned');

	// listRuns confirms the same: 2 completed + 1 active = 3 total.
	const all = ops.listRuns({});
	assert.equal(all.runs.length, 3);
});

console.log('\nhandleRegistryRequest (REST router):');

await test('GET /pointers/<runId>: 200 + body for hit, 404 for miss', async () => {
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
	assert.equal(hit.status, 200);
	const body = await hit.json();
	assert.equal(body.runId, 'run_rest_01');

	const miss = await handleRegistryRequest(
		ops,
		new Request('https://registry/pointers/nope', { method: 'GET' }),
	);
	assert.equal(miss.status, 404);
});

await test('POST /pointers/<runId>/start: 204 and pointer is now lookup-able', async () => {
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
	assert.equal(res.status, 204);
	assert.equal(ops.lookupRun('run_rest_start').status, 'active');
});

await test('POST /pointers/<runId>/end: 204 and pointer status is updated', async () => {
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
	assert.equal(res.status, 204);
	const pointer = ops.lookupRun('run_rest_end');
	assert.equal(pointer.status, 'completed');
	assert.equal(pointer.endedAt, ENDED_AT);
});

await test('GET /pointers (list) and /instances: respond JSON; honor query params', async () => {
	const ops = createRegistryOps(makeFakeSql());
	ops.recordRunStart({ runId: 'L1', agentName: 'hello', instanceId: 'inst_a', startedAt: STARTED_AT_1 });
	ops.recordRunStart({ runId: 'L2', agentName: 'world', instanceId: 'inst_b', startedAt: STARTED_AT_2 });

	const listAll = await handleRegistryRequest(
		ops,
		new Request('https://registry/pointers', { method: 'GET' }),
	);
	const listAllBody = await listAll.json();
	assert.equal(listAllBody.runs.length, 2);

	const listFiltered = await handleRegistryRequest(
		ops,
		new Request('https://registry/pointers?agent=hello', { method: 'GET' }),
	);
	const listFilteredBody = await listFiltered.json();
	assert.deepEqual(listFilteredBody.runs.map((r) => r.runId), ['L1']);

	const instances = await handleRegistryRequest(
		ops,
		new Request('https://registry/instances?agent=hello', { method: 'GET' }),
	);
	const instancesBody = await instances.json();
	assert.deepEqual(instancesBody.instances, [{ agentName: 'hello', instanceId: 'inst_a' }]);
});

await test('Unknown route: 404 with debug-friendly body', async () => {
	const ops = createRegistryOps(makeFakeSql());
	const res = await handleRegistryRequest(
		ops,
		new Request('https://registry/whatever', { method: 'GET' }),
	);
	assert.equal(res.status, 404);
});

console.log(`\nAll Commit B FlueRegistry ops tests passed (${passed}/${passed}).`);
