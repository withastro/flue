import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRunRegistry } from '../src/node/run-registry.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { flue } from '../src/routing.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import type { RunRegistry } from '../src/runtime/run-registry.ts';
import type { RunRecord, RunStore } from '../src/runtime/run-store.ts';
import {
	createRunSubscriberRegistry,
	type RunSubscriberRegistry,
} from '../src/runtime/run-subscribers.ts';
import type { FlueEvent } from '../src/types.ts';

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

async function readSseData(response: Response): Promise<FlueEvent[]> {
	const body = await response.text();
	return body
		.split('\n')
		.filter((line) => line.startsWith('data: '))
		.map((line) => JSON.parse(line.slice('data: '.length)) as FlueEvent);
}

class DelayedReplayRunStore implements RunStore {
	private inner = new InMemoryRunStore();
	private resolveReplayStarted!: () => void;
	private resolveReplay!: () => void;
	private delayNextRead = true;
	readonly replayStarted = new Promise<void>((resolve) => {
		this.resolveReplayStarted = resolve;
	});
	private readonly replayReleased = new Promise<void>((resolve) => {
		this.resolveReplay = resolve;
	});

	createRun(input: Parameters<RunStore['createRun']>[0]): Promise<void> {
		return this.inner.createRun(input);
	}

	endRun(input: Parameters<RunStore['endRun']>[0]): Promise<void> {
		return this.inner.endRun(input);
	}

	appendEvent(runId: string, event: FlueEvent): Promise<void> {
		return this.inner.appendEvent(runId, event);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		if (this.delayNextRead) {
			this.delayNextRead = false;
			this.resolveReplayStarted();
			await this.replayReleased;
		}
		return this.inner.getEvents(runId, fromIndex);
	}

	getRun(runId: string): Promise<RunRecord | null> {
		return this.inner.getRun(runId);
	}

	releaseReplay(): void {
		this.resolveReplay();
	}
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
	it('returns a workflow run record when a registered run id is requested', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01'),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
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

	it('returns filtered workflow events when event types are requested', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'kept',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'idle',
			runId: 'workflow:daily-report:01',
			eventIndex: 1,
		});
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/events?types=log'),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			events: [
				{
					type: 'log',
					level: 'info',
					message: 'kept',
					runId: 'workflow:daily-report:01',
					eventIndex: 0,
				},
			],
		});
	});

	it('resumes workflow event listing after an event index when after is supplied', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
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
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/events?after=0'),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			events: [
				{
					type: 'log',
					level: 'info',
					message: 'second',
					runId: 'workflow:daily-report:01',
					eventIndex: 1,
				},
			],
		});
	});

	it('replays terminal workflow events and closes when a terminal stream is requested', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
			message: 'finished',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'run_end',
			runId: 'workflow:daily-report:01',
			isError: false,
			durationMs: 10,
			eventIndex: 1,
		});
		await store.endRun({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:00:00.010Z',
			durationMs: 10,
			isError: false,
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(await readSseData(response)).toEqual([
			{
				type: 'log',
				level: 'info',
				message: 'finished',
				runId: 'workflow:daily-report:01',
				eventIndex: 0,
			},
			{
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 1,
			},
		]);
	});

	it('delivers each workflow event exactly once when events arrive while an active stream catches up with history', async () => {
		const store = new DelayedReplayRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
		const subscribers = createRunSubscriberRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'persisted before replay',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		const app = createRunApp(store, registry, subscribers);
		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
		);
		try {
			await store.replayStarted;
			await store.appendEvent('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'persisted during replay',
				runId: 'workflow:daily-report:01',
				eventIndex: 1,
			});
			subscribers.publish('workflow:daily-report:01', {
				type: 'log',
				level: 'info',
				message: 'persisted during replay',
				runId: 'workflow:daily-report:01',
				eventIndex: 1,
			});
			await store.appendEvent('workflow:daily-report:01', {
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 2,
			});
			subscribers.publish('workflow:daily-report:01', {
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 2,
			});
			store.releaseReplay();

			expect((await readSseData(response)).map((event) => event.eventIndex)).toEqual([0, 1, 2]);
		} finally {
			store.releaseReplay();
			if (response.body && !response.body.locked) await response.body.cancel();
		}
	});

	it('delivers workflow events without gaps when a burst arrives while an active stream catches up with history', async () => {
		const store = new DelayedReplayRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
		const subscribers = createRunSubscriberRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry, subscribers);
		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
		);
		try {
			await store.replayStarted;
			for (let eventIndex = 0; eventIndex < 1002; eventIndex++) {
				await store.appendEvent('workflow:daily-report:01', {
					type: 'log',
					level: 'info',
					message: `event ${eventIndex}`,
					runId: 'workflow:daily-report:01',
					eventIndex,
				});
				subscribers.publish('workflow:daily-report:01', {
					type: 'log',
					level: 'info',
					message: `event ${eventIndex}`,
					runId: 'workflow:daily-report:01',
					eventIndex,
				});
			}
			await store.appendEvent('workflow:daily-report:01', {
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 1002,
			});
			subscribers.publish('workflow:daily-report:01', {
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 1002,
			});
			store.releaseReplay();

			expect((await readSseData(response)).map((event) => event.eventIndex)).toEqual(
				Array.from({ length: 1003 }, (_, eventIndex) => eventIndex),
			);
		} finally {
			store.releaseReplay();
			if (response.body && !response.body.locked) await response.body.cancel();
		}
	});

	it('resumes an event stream after the last event id when a client reconnects', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
			message: 'already received',
			runId: 'workflow:daily-report:01',
			eventIndex: 0,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'last received',
			runId: 'workflow:daily-report:01',
			eventIndex: 1,
		});
		await store.appendEvent('workflow:daily-report:01', {
			type: 'run_end',
			runId: 'workflow:daily-report:01',
			isError: false,
			durationMs: 10,
			eventIndex: 2,
		});
		await store.endRun({
			runId: 'workflow:daily-report:01',
			endedAt: '2026-06-01T10:00:00.010Z',
			durationMs: 10,
			isError: false,
		});
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream', {
				headers: { 'last-event-id': '1' },
			}),
		);

		expect(await readSseData(response)).toEqual([
			{
				type: 'run_end',
				runId: 'workflow:daily-report:01',
				isError: false,
				durationMs: 10,
				eventIndex: 2,
			},
		]);
	});

	it('closes an active stream with an error when a malformed live workflow event is published', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
		const subscribers = createRunSubscriberRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry, subscribers);
		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
		);
		await Promise.resolve();

		subscribers.publish('workflow:daily-report:01', {
			type: 'log',
			level: 'info',
			message: 'missing index',
			runId: 'workflow:daily-report:01',
		});
		const body = await response.text();

		expect(body).toContain('event: error\n');
		expect(body).not.toContain('id: 0\n');
	});

	it('omits a fabricated cursor when replay fails before an active stream sends an event', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
		const subscribers = createRunSubscriberRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		vi.spyOn(store, 'getEvents').mockRejectedValueOnce(new Error('replay failed'));
		const app = createRunApp(store, registry, subscribers);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
		);
		const body = await response.text();

		expect(body).toContain('event: error\n');
		expect(body).not.toContain('id: 0\n');
	});

	it('rejects active run streaming when the runtime has no subscriber registry', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const response = await app.fetch(
				new Request('http://localhost/runs/workflow%3Adaily-report%3A01/stream'),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('rejects an unknown workflow run when a run id is not registered', async () => {
		const app = createRunApp(new InMemoryRunStore(), new InMemoryRunRegistry());

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3Amissing'),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				type: 'run_not_found',
				message: 'Run "workflow:daily-report:missing" was not found.',
				details: 'Verify the run id is correct and its history is still available.',
			},
		});
	});

	it('returns run_not_found when a registry pointer resolves to a mismatched owner', async () => {
		const store: RunStore = new InMemoryRunStore();
		const registry: RunRegistry = new InMemoryRunRegistry();
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
		await registry.recordRunStart({
			runId: 'workflow:daily-report:01',
			owner: {
				kind: 'workflow',
				workflowName: 'forged-workflow',
				instanceId: 'workflow:daily-report:01',
			},
			startedAt: '2026-06-01T10:00:00.000Z',
		});
		const app = createRunApp(store, registry);

		const response = await app.fetch(
			new Request('http://localhost/runs/workflow%3Adaily-report%3A01'),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				type: 'run_not_found',
				message: 'Run "workflow:daily-report:01" was not found.',
				details: 'Verify the run id is correct and its history is still available.',
			},
		});
	});
});
