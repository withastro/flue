import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRunRegistry } from '../src/node/run-registry.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { flue } from '../src/routing.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import type { RunRegistry } from '../src/runtime/run-registry.ts';
import type { RunStore } from '../src/runtime/run-store.ts';
import type { RunSubscriberRegistry } from '../src/runtime/run-subscribers.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

function createRunApp(
	runStore: RunStore,
	runRegistry: RunRegistry,
	runSubscribers?: RunSubscriberRegistry,
) {
	configureFlueRuntime({
		target: 'node',
		manifest: { agents: [] },
		runStore,
		runRegistry,
		runSubscribers,
	});
	const app = new Hono();
	app.route('/', flue());
	return app;
}


describe('workflow run store', () => {
	it('creates an active workflow run record when workflow admission is persisted', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
		});

		expect(await store.getRun('workflow:daily-report:01')).toEqual({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			status: 'active',
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
		});
	});

	it('finalizes a completed workflow run record when workflow execution succeeds', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
		});
		await store.endRun({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: false,
			result: { delivered: true },
		});

		expect(await store.getRun('workflow:daily-report:01')).toEqual({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			status: 'completed',
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
			endedAt: '2026-06-01T10:05:00.000Z',
			isError: false,
			durationMs: 300_000,
			result: { delivered: true },
			error: undefined,
		});
	});

	it('finalizes an errored workflow run record when workflow execution fails', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
		});
		await store.endRun({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: true,
			error: { message: 'delivery failed' },
		});

		expect(await store.getRun('workflow:daily-report:01')).toEqual({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			status: 'errored',
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
			endedAt: '2026-06-01T10:05:00.000Z',
			isError: true,
			durationMs: 300_000,
			result: undefined,
			error: { message: 'delivery failed' },
		});
	});

	it('preserves event order when workflow events are appended', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'first',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'second',
			runId: 'workflow:daily-report:01',
			eventIndex: 1,
		});

		expect(await store.getEvents('workflow:daily-report:01')).toEqual([
			{
				type: 'log',
				level: 'info',
				message: 'first',
				runId: 'workflow:daily-report:01',
				eventIndex: 0,
			},
			{
				type: 'log',
				level: 'info',
				message: 'second',
				runId: 'workflow:daily-report:01',
				eventIndex: 1,
			},
		]);
	});

	it('returns workflow events in index order when appends arrive out of order', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'second',
			runId: 'workflow:daily-report:01',
			eventIndex: 1,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'first',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});

		expect(
			(await store.getEvents('workflow:daily-report:01')).map((event) => event.eventIndex),
		).toEqual([0, 1]);
	});

	it('rejects duplicate workflow event indexes when events are appended', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'first',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});

		await expect(
			store.appendEvent('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'replacement',
				runId: 'workflow:daily-report:01',
				eventIndex: 0,
			}),
		).rejects.toThrow('duplicate persisted workflow event index');
		expect(await store.getEvents('workflow:daily-report:01')).toMatchObject([{ message: 'first' }]);
	});

	it('rejects malformed workflow events when persistence identity is missing or mismatched', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});

		await expect(
			store.appendEvent('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'missing index',
				runId: 'workflow:daily-report:01',
			}),
		).rejects.toThrow('index must be a non-negative integer');
		await expect(
			store.appendEvent('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'wrong run',
				runId: 'workflow:daily-report:02',
				eventIndex: 0,
			}),
		).rejects.toThrow('runId does not match its run');
	});

	it('returns events from a requested index when run events are paged', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'first',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'second',
			runId: 'workflow:daily-report:01',
			eventIndex: 1,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'third',
			runId: 'workflow:daily-report:01',
			eventIndex: 2,
		});

		expect(await store.getEvents('workflow:daily-report:01', 1)).toEqual([
			{
				type: 'log',
				level: 'info',
				message: 'second',
				runId: 'workflow:daily-report:01',
				eventIndex: 1,
			},
			{
				type: 'log',
				level: 'info',
				message: 'third',
				runId: 'workflow:daily-report:01',
				eventIndex: 2,
			},
		]);
	});

	it('rejects oversized events when serialized persistence exceeds the supported limit', async () => {
		const store: RunStore = new InMemoryRunStore();
		await store.createRun({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: {},
		});

		await expect(
			store.appendEvent('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'x'.repeat(1_100_000),
				runId: 'workflow:daily-report:01',
				eventIndex: 0,
			}),
		).rejects.toThrow('event payload exceeds the 1 MB persistence limit');
		expect(await store.getEvents('workflow:daily-report:01')).toEqual([]);
	});

	it('rejects workflow run admission when owner instanceId differs from runId', async () => {
		const store: RunStore = new InMemoryRunStore();

		await expect(
			store.createRun({
				runId: 'workflow:daily-report:01',
				owner: {
					kind: 'workflow',
					workflowName: 'daily-report',
					instanceId: 'workflow:daily-report:02',
				},
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: {},
			}),
		).rejects.toThrow('same instanceId as the run record runId');
	});
});

describe('workflow run registry', () => {
	it('records an active pointer when a workflow run starts', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});

		expect(await registry.lookupRun('workflow:daily-report:01')).toEqual({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			status: 'active',
			startedAt: '2026-06-01T10:00:00.000Z',
		});
	});

	it('updates a pointer terminal status when a workflow run ends', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry.recordRunEnd({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: true,
		});

		expect(await registry.lookupRun('workflow:daily-report:01')).toEqual({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			status: 'errored',
			startedAt: '2026-06-01T10:00:00.000Z',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: true,
		});
	});

	it('lists pointers newest first when multiple workflow runs exist', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:02',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:02',
			},
			startedAt: '2026-06-01T10:02:00.000Z',
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:03',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:03',
			},
			startedAt: '2026-06-01T10:01:00.000Z',
		});

		expect((await registry.listRuns()).runs.map((pointer) => pointer.runId)).toEqual([
			'workflow:daily-report:02',
			'workflow:daily-report:03',
			'workflow:daily-report:01',
		]);
	});

	it('filters pointers when status or workflow name is requested', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry.recordRunEnd({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: false,
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:02',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:02',
			},
			startedAt: '2026-06-01T10:01:00.000Z',
		});
		await registry.recordRunEnd({
			runId: 'workflow:daily-report:02',
			endedAt: '2026-06-01T10:06:00.000Z',
			durationMs: 300_000,
			isError: true,
		});
		await registry.recordRunStart({
			runId: 'workflow:invoice:01',
			owner: {
				kind: 'workflow',
				workflowName: 'invoice',
				instanceId: 'workflow:invoice:01',
			},
			startedAt: '2026-06-01T10:02:00.000Z',
		});

		expect(
			(await registry.listRuns({ status: 'errored' })).runs.map((pointer) => pointer.runId),
		).toEqual(['workflow:daily-report:02']);
		expect(
			(await registry.listRuns({ workflowName: 'daily-report' })).runs.map(
				(pointer) => pointer.runId,
			),
		).toEqual(['workflow:daily-report:02', 'workflow:daily-report:01']);
	});

	it('continues pointer listing when a cursor is supplied', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:02',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:02',
			},
			startedAt: '2026-06-01T10:01:00.000Z',
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:03',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:03',
			},
			startedAt: '2026-06-01T10:02:00.000Z',
		});

		const firstPage = await registry.listRuns({ limit: 2 });
		expect(firstPage.runs.map((pointer) => pointer.runId)).toEqual([
			'workflow:daily-report:03',
			'workflow:daily-report:02',
		]);
		expect(firstPage.nextCursor).toEqual(expect.any(String));
		expect((await registry.listRuns({ limit: 2, cursor: firstPage.nextCursor })).runs).toEqual([
			{
				runId: 'workflow:daily-report:01',
				owner: {
					kind: 'workflow',
					workflowName: 'daily-report',
					instanceId: 'workflow:daily-report:01',
				},
				status: 'active',
				startedAt: '2026-06-01T10:00:00.000Z',
			},
		]);
	});

	it('rejects owner identity mismatches when a workflow pointer is recorded', async () => {
		const registry: RunRegistry = new InMemoryRunRegistry();

		await expect(
			registry.recordRunStart({
				runId: 'workflow:daily-report:01',
				owner: {
					kind: 'workflow',
					workflowName: 'daily-report',
					instanceId: 'workflow:daily-report:02',
				},
				startedAt: '2026-06-01T10:00:00.000Z',
			}),
		).rejects.toThrow('same instanceId as the pointer runId');
	});
});

describe('workflow run routes', () => {
	it('returns 404 for a stream that does not exist when GET /runs/:runId is requested', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3Amissing'),
		);

		expect(response.status).toBe(404);
	});

});
