#!/usr/bin/env node
/**
 * Inline test script for the InMemoryRunRegistry + the bare /runs/:runId
 * routes wired into `flue()`. No test framework — just imports the built
 * runtime, exercises the surface, and asserts with `node:assert/strict`.
 *
 * Run from packages/runtime/ after a fresh build:
 *
 *   pnpm run build && node test/run-registry.mjs
 *
 * Exits non-zero on any failure. Intended for the Phase 1 Commit A
 * verification pass; consolidated into a real test framework later.
 */
// biome-ignore-all lint/suspicious/noConsole: test runner output is its UX
// biome-ignore-all lint/correctness/useImportExtensions: importing from built
// dist/.mjs files which already carry their extensions in the specifier
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
	configureFlueRuntime,
	createFlueContext,
	createRunSubscriberRegistry,
	InMemoryRunRegistry,
	InMemoryRunStore,
} from '../dist/internal.mjs';
import { flue } from '../dist/app.mjs';

// ─── Direct registry unit tests ────────────────────────────────────────────

async function testRegistryBasics() {
	const registry = new InMemoryRunRegistry();

	await registry.recordRunStart({
		runId: 'run_a',
		agentName: 'hello',
		instanceId: 'inst-1',
		startedAt: '2026-01-01T00:00:00.000Z',
	});
	await registry.recordRunStart({
		runId: 'run_b',
		agentName: 'hello',
		instanceId: 'inst-2',
		startedAt: '2026-01-01T00:00:01.000Z',
	});
	await registry.recordRunStart({
		runId: 'run_c',
		agentName: 'greet',
		instanceId: 'inst-3',
		startedAt: '2026-01-01T00:00:02.000Z',
	});

	const a = await registry.lookupRun('run_a');
	assert.equal(a?.runId, 'run_a');
	assert.equal(a?.agentName, 'hello');
	assert.equal(a?.instanceId, 'inst-1');
	assert.equal(a?.status, 'active');

	assert.equal(await registry.lookupRun('run_missing'), null);

	await registry.recordRunEnd({
		runId: 'run_a',
		endedAt: '2026-01-01T00:00:05.000Z',
		durationMs: 5000,
		isError: false,
	});
	const aDone = await registry.lookupRun('run_a');
	assert.equal(aDone?.status, 'completed');
	assert.equal(aDone?.endedAt, '2026-01-01T00:00:05.000Z');
	assert.equal(aDone?.durationMs, 5000);
	assert.equal(aDone?.isError, false);

	await registry.recordRunEnd({
		runId: 'run_b',
		endedAt: '2026-01-01T00:00:06.000Z',
		durationMs: 5000,
		isError: true,
	});
	const bDone = await registry.lookupRun('run_b');
	assert.equal(bDone?.status, 'errored');
	assert.equal(bDone?.isError, true);

	console.log('  ✓ registry basics: record/lookup/end');
}

async function testRegistryListRuns() {
	const registry = new InMemoryRunRegistry();
	for (let i = 0; i < 5; i++) {
		await registry.recordRunStart({
			runId: `run_${i}`,
			agentName: i % 2 === 0 ? 'hello' : 'greet',
			instanceId: `inst-${i}`,
			startedAt: `2026-01-01T00:00:0${i}.000Z`,
		});
	}

	const all = await registry.listRuns();
	assert.equal(all.runs.length, 5);
	// Descending by startedAt: run_4, run_3, ..., run_0
	assert.equal(all.runs[0].runId, 'run_4');
	assert.equal(all.runs[4].runId, 'run_0');

	const helloOnly = await registry.listRuns({ agentName: 'hello' });
	assert.equal(helloOnly.runs.length, 3);
	assert.ok(helloOnly.runs.every((r) => r.agentName === 'hello'));

	const page1 = await registry.listRuns({ limit: 2 });
	assert.equal(page1.runs.length, 2);
	assert.ok(page1.nextCursor);
	const page2 = await registry.listRuns({ limit: 2, cursor: page1.nextCursor });
	assert.equal(page2.runs.length, 2);
	const page3 = await registry.listRuns({ limit: 2, cursor: page2.nextCursor });
	assert.equal(page3.runs.length, 1);
	assert.equal(page3.nextCursor, undefined);

	// Collected ids across pages = full set, no dups.
	const collected = new Set([
		...page1.runs.map((r) => r.runId),
		...page2.runs.map((r) => r.runId),
		...page3.runs.map((r) => r.runId),
	]);
	assert.equal(collected.size, 5);

	console.log('  ✓ listRuns: filter + cursor pagination');
}

async function testRegistryListInstances() {
	const registry = new InMemoryRunRegistry();
	await registry.recordRunStart({
		runId: 'r1',
		agentName: 'hello',
		instanceId: 'a',
		startedAt: '2026-01-01T00:00:00.000Z',
	});
	await registry.recordRunStart({
		runId: 'r2',
		agentName: 'hello',
		instanceId: 'b',
		startedAt: '2026-01-01T00:00:01.000Z',
	});
	await registry.recordRunStart({
		runId: 'r3',
		agentName: 'greet',
		instanceId: 'a',
		startedAt: '2026-01-01T00:00:02.000Z',
	});
	// Duplicate (agentName, instanceId) — should not appear twice.
	await registry.recordRunStart({
		runId: 'r4',
		agentName: 'hello',
		instanceId: 'a',
		startedAt: '2026-01-01T00:00:03.000Z',
	});

	const out = await registry.listInstances();
	assert.equal(out.instances.length, 3);
	const ids = out.instances.map((i) => `${i.agentName}/${i.instanceId}`).sort();
	assert.deepEqual(ids, ['greet/a', 'hello/a', 'hello/b']);

	console.log('  ✓ listInstances: distinct (agent, instance) tuples');
}

async function testRegistryPruning() {
	const registry = new InMemoryRunRegistry({ maxCompletedRunsPerAgent: 3 });

	// 5 completed runs for one agent — only the last 3 should survive.
	for (let i = 0; i < 5; i++) {
		const id = `run_${i}`;
		await registry.recordRunStart({
			runId: id,
			agentName: 'hello',
			instanceId: 'inst-1',
			startedAt: `2026-01-01T00:00:0${i}.000Z`,
		});
		await registry.recordRunEnd({
			runId: id,
			endedAt: `2026-01-01T00:00:0${i + 1}.000Z`,
			durationMs: 1000,
			isError: false,
		});
	}

	const list = await registry.listRuns({ agentName: 'hello' });
	assert.equal(list.runs.length, 3);
	const survivingIds = list.runs.map((r) => r.runId).sort();
	assert.deepEqual(survivingIds, ['run_2', 'run_3', 'run_4']);
	assert.equal(await registry.lookupRun('run_0'), null);
	assert.equal(await registry.lookupRun('run_1'), null);

	// Active runs are never pruned.
	const registry2 = new InMemoryRunRegistry({ maxCompletedRunsPerAgent: 1 });
	for (let i = 0; i < 5; i++) {
		await registry2.recordRunStart({
			runId: `active_${i}`,
			agentName: 'hello',
			instanceId: 'x',
			startedAt: `2026-01-01T00:00:0${i}.000Z`,
		});
	}
	const stillActive = await registry2.listRuns({ agentName: 'hello' });
	assert.equal(stillActive.runs.length, 5);

	console.log('  ✓ pruning: per-agent cap, active runs preserved');
}

// ─── Integration test: bare /runs/:runId routes ────────────────────────────

async function testBareRouteIntegration() {
	const runStore = new InMemoryRunStore();
	const runRegistry = new InMemoryRunRegistry();
	const runSubscribers = createRunSubscriberRegistry();

	configureFlueRuntime({
		target: 'node',
		webhookAgents: ['hello'],
		allowNonWebhook: false,
		handlers: {
			hello: async (_ctx) => ({ greeting: 'hi' }),
		},
		createContext: (id, runId, payload, req) =>
			createFlueContext({
				id,
				runId,
				payload,
				env: {},
				req,
				agentConfig: {
					systemPrompt: '',
					skills: {},
					roles: [],
					model: undefined,
					resolveModel: () => undefined,
				},
				createDefaultEnv: async () => ({}),
				createLocalEnv: async () => ({}),
				defaultStore: undefined,
			}),
		runStore,
		runRegistry,
		runSubscribers,
	});

	const app = new Hono();
	app.route('/', flue());

	// Invoke the agent. Sync mode.
	const invoke = await app.fetch(
		new Request('http://localhost/agents/hello/inst-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		}),
	);
	assert.equal(invoke.status, 200);
	const invokeBody = await invoke.json();
	const runId = invokeBody._meta?.runId;
	assert.ok(typeof runId === 'string' && runId.startsWith('run_'), 'invoke response missing runId');

	// Same body via legacy + bare routes.
	const legacy = await app.fetch(new Request(`http://localhost/agents/hello/inst-1/runs/${runId}`));
	assert.equal(legacy.status, 200);
	const legacyBody = await legacy.json();

	const bare = await app.fetch(new Request(`http://localhost/runs/${runId}`));
	assert.equal(bare.status, 200);
	const bareBody = await bare.json();

	assert.deepEqual(bareBody, legacyBody);
	assert.equal(bareBody.runId, runId);
	assert.equal(bareBody.agentName, 'hello');
	assert.equal(bareBody.instanceId, 'inst-1');
	assert.equal(bareBody.status, 'completed');

	// Unknown runId via bare route → 404 with canonical envelope.
	const missing = await app.fetch(new Request('http://localhost/runs/run_does_not_exist'));
	assert.equal(missing.status, 404);
	const missingBody = await missing.json();
	assert.equal(missingBody.error?.type, 'run_not_found');

	// Events endpoint via bare route.
	const eventsRes = await app.fetch(new Request(`http://localhost/runs/${runId}/events`));
	assert.equal(eventsRes.status, 200);
	const eventsBody = await eventsRes.json();
	assert.ok(Array.isArray(eventsBody.events));
	// Should at minimum contain run_start and run_end.
	const types = new Set(eventsBody.events.map((e) => e.type));
	assert.ok(types.has('run_start'), 'expected run_start event');
	assert.ok(types.has('run_end'), 'expected run_end event');

	// Stream endpoint via bare route on a terminal run returns SSE-replay.
	const streamRes = await app.fetch(new Request(`http://localhost/runs/${runId}/stream`));
	assert.equal(streamRes.status, 200);
	assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
	const streamBody = await streamRes.text();
	assert.match(streamBody, /event: run_start/);
	assert.match(streamBody, /event: run_end/);

	console.log('  ✓ bare /runs/:runId integration: get / events / stream all OK');
}

async function testBareRouteWithoutRegistry() {
	// If the runtime is configured without a runRegistry, the bare route
	// should surface a structured 501 envelope (not a 500 / stack trace).
	configureFlueRuntime({
		target: 'node',
		webhookAgents: ['hello'],
		allowNonWebhook: false,
		handlers: { hello: async () => null },
		createContext: (id, runId, payload, req) =>
			createFlueContext({
				id,
				runId,
				payload,
				env: {},
				req,
				agentConfig: {
					systemPrompt: '',
					skills: {},
					roles: [],
					model: undefined,
					resolveModel: () => undefined,
				},
				createDefaultEnv: async () => ({}),
				createLocalEnv: async () => ({}),
				defaultStore: undefined,
			}),
		runStore: new InMemoryRunStore(),
		runSubscribers: createRunSubscriberRegistry(),
		// runRegistry intentionally omitted
	});

	const app = new Hono();
	app.route('/', flue());

	const res = await app.fetch(new Request('http://localhost/runs/run_anything'));
	assert.equal(res.status, 501);
	const body = await res.json();
	assert.equal(body.error?.type, 'run_registry_unavailable');

	console.log('  ✓ missing registry → structured 501 envelope');
}

// ─── Driver ────────────────────────────────────────────────────────────────

async function main() {
	console.log('InMemoryRunRegistry:');
	await testRegistryBasics();
	await testRegistryListRuns();
	await testRegistryListInstances();
	await testRegistryPruning();
	console.log('Bare /runs/:runId routes:');
	await testBareRouteIntegration();
	await testBareRouteWithoutRegistry();
	console.log('\nAll Commit A tests passed.');
}

main().catch((err) => {
	console.error('FAIL:', err);
	process.exit(1);
});
