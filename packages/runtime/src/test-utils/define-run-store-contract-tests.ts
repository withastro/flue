import { afterEach, describe, expect, it } from 'vitest';
import type { RunStore } from '../runtime/run-store.ts';

export interface RunStoreContractBackend {
	create(): RunStore | Promise<RunStore>;
	cleanup?(): void | Promise<void>;
}

export function defineRunStoreContractTests(label: string, backend: RunStoreContractBackend): void {
	describe(label, () => {
		let cleanup: (() => void | Promise<void>) | undefined;

		async function create(): Promise<RunStore> {
			cleanup = backend.cleanup;
			return backend.create();
		}

		afterEach(async () => {
			await cleanup?.();
			cleanup = undefined;
		});

		it('persists an active run record when createRun() is called', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});

			expect(await store.getRun('run_01DAILYREPORT')).toMatchObject({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				status: 'active',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});
		});

		it('preserves the existing record when createRun() replays a run id', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});
			await store.endRun({
				runId: 'run_01DAILYREPORT',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
				result: { delivered: true },
			});

			// Idempotent first-writer-wins: a replayed createRun must not
			// resurrect the terminal record to 'active' or null its result.
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T11:00:00.000Z',
				payload: { report: 'replayed' },
			});

			expect(await store.getRun('run_01DAILYREPORT')).toMatchObject({
				status: 'completed',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
				endedAt: '2026-06-01T10:05:00.000Z',
				result: { delivered: true },
			});
			expect(await store.lookupRun('run_01DAILYREPORT')).toMatchObject({
				status: 'completed',
				startedAt: '2026-06-01T10:00:00.000Z',
			});
		});

		it('finalizes a completed run record when endRun() reports success', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});
			await store.endRun({
				runId: 'run_01DAILYREPORT',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
				result: { delivered: true },
			});

			expect(await store.getRun('run_01DAILYREPORT')).toMatchObject({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				status: 'completed',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
				endedAt: '2026-06-01T10:05:00.000Z',
				isError: false,
				durationMs: 300_000,
				result: { delivered: true },
			});
		});

		it('finalizes an errored run record when endRun() reports failure', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});
			await store.endRun({
				runId: 'run_01DAILYREPORT',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: true,
				error: { message: 'delivery failed' },
			});

			expect(await store.getRun('run_01DAILYREPORT')).toMatchObject({
				status: 'errored',
				isError: true,
				error: { message: 'delivery failed' },
			});
		});

		it('treats endRun() as a no-op when no record exists for the run id', async () => {
			const store = await create();
			await store.endRun({
				runId: 'run_01MISSING',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
			});

			expect(await store.getRun('run_01MISSING')).toBeNull();
			expect((await store.listRuns()).runs).toEqual([]);
		});

		it('returns the pointer projection without payload or result when lookupRun() resolves a run', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: { report: 'weekly' },
			});
			await store.endRun({
				runId: 'run_01DAILYREPORT',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
				result: { delivered: true },
			});

			expect(await store.lookupRun('run_01DAILYREPORT')).toEqual({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				status: 'completed',
				startedAt: '2026-06-01T10:00:00.000Z',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
			});
		});

		it('returns null when lookupRun() receives an unknown run id', async () => {
			const store = await create();
			expect(await store.lookupRun('run_01MISSING')).toBeNull();
		});

		it('lists run pointers newest first when listRuns() is called', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: {},
			});
			await store.createRun({
				runId: 'run_02DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:02:00.000Z',
				payload: {},
			});
			await store.createRun({
				runId: 'run_03DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:01:00.000Z',
				payload: {},
			});

			expect((await store.listRuns()).runs.map((pointer) => pointer.runId)).toEqual([
				'run_02DAILYREPORT',
				'run_03DAILYREPORT',
				'run_01DAILYREPORT',
			]);
		});

		it('filters run pointers when status or workflow name is requested', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: {},
			});
			await store.endRun({
				runId: 'run_01DAILYREPORT',
				endedAt: '2026-06-01T10:05:00.000Z',
				durationMs: 300_000,
				isError: false,
			});
			await store.createRun({
				runId: 'run_02DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:01:00.000Z',
				payload: {},
			});
			await store.endRun({
				runId: 'run_02DAILYREPORT',
				endedAt: '2026-06-01T10:06:00.000Z',
				durationMs: 300_000,
				isError: true,
			});
			await store.createRun({
				runId: 'run_01INVOICE',
				workflowName: 'invoice',
				startedAt: '2026-06-01T10:02:00.000Z',
				payload: {},
			});

			expect(
				(await store.listRuns({ status: 'errored' })).runs.map((pointer) => pointer.runId),
			).toEqual(['run_02DAILYREPORT']);
			expect(
				(await store.listRuns({ workflowName: 'daily-report' })).runs.map(
					(pointer) => pointer.runId,
				),
			).toEqual(['run_02DAILYREPORT', 'run_01DAILYREPORT']);
		});

		it('continues run listing when a cursor is supplied', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: {},
			});
			await store.createRun({
				runId: 'run_02DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:01:00.000Z',
				payload: {},
			});
			await store.createRun({
				runId: 'run_03DAILYREPORT',
				workflowName: 'daily-report',
				startedAt: '2026-06-01T10:02:00.000Z',
				payload: {},
			});

			const firstPage = await store.listRuns({ limit: 2 });
			expect(firstPage.runs.map((pointer) => pointer.runId)).toEqual([
				'run_03DAILYREPORT',
				'run_02DAILYREPORT',
			]);
			expect(firstPage.nextCursor).toEqual(expect.any(String));

			const secondPage = await store.listRuns({ limit: 2, cursor: firstPage.nextCursor });
			expect(secondPage.runs.map((pointer) => pointer.runId)).toEqual(['run_01DAILYREPORT']);
			expect(secondPage.nextCursor).toBeUndefined();
		});

		it('continues run listing when the page boundary lands on a non-Latin1 workflow name', async () => {
			const store = await create();
			await store.createRun({
				runId: 'run_01NIPPO',
				workflowName: '日報',
				startedAt: '2026-06-01T10:00:00.000Z',
				payload: {},
			});
			await store.createRun({
				runId: 'run_02NIPPO',
				workflowName: '日報',
				startedAt: '2026-06-01T10:01:00.000Z',
				payload: {},
			});

			const firstPage = await store.listRuns({ limit: 1 });
			expect(firstPage.runs.map((pointer) => pointer.runId)).toEqual(['run_02NIPPO']);
			expect(firstPage.nextCursor).toEqual(expect.any(String));
			expect((await store.listRuns({ limit: 1, cursor: firstPage.nextCursor })).runs).toMatchObject(
				[{ runId: 'run_01NIPPO', workflowName: '日報' }],
			);
		});
	});
}
