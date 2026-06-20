import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRunStore } from '../src/node/run-store.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { getRun, listAgents, listRuns } from '../src/runtime/inspect.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('listRuns()', () => {
	it('lists run pointers from the ambient run store when runs exist', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: { report: 'weekly' },
		});
		await runStore.endRun({
			runId: 'run_01DAILYREPORT',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: false,
			result: { delivered: true },
		});
		configureFlueRuntime({ target: 'node', manifest: { agents: [] }, runStore });

		await expect(listRuns()).resolves.toEqual({
			runs: [
				{
					runId: 'run_01DAILYREPORT',
					workflowName: 'daily-report',
					status: 'completed',
					startedAt: '2026-06-01T10:00:00.000Z',
					endedAt: '2026-06-01T10:05:00.000Z',
					durationMs: 300_000,
					isError: false,
				},
			],
		});
	});

	it('forwards status, workflowName, limit, and cursor options to the run store', async () => {
		const runStore = new InMemoryRunStore();
		const listRunsSpy = vi.spyOn(runStore, 'listRuns');
		configureFlueRuntime({ target: 'node', manifest: { agents: [] }, runStore });

		await listRuns({
			status: 'errored',
			workflowName: 'daily-report',
			limit: 25,
			cursor: 'next-page',
		});

		expect(listRunsSpy).toHaveBeenCalledExactlyOnceWith({
			status: 'errored',
			workflowName: 'daily-report',
			limit: 25,
			cursor: 'next-page',
		});
	});

	it('rejects with a configuration error when no runtime is configured', async () => {
		await expect(listRuns()).rejects.toThrow('listRuns() called before runtime was configured');
	});
});

describe('getRun()', () => {
	it('returns the persisted run record when the run exists', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: { report: 'weekly' },
		});
		configureFlueRuntime({ target: 'node', manifest: { agents: [] }, runStore });

		await expect(getRun('run_01DAILYREPORT')).resolves.toEqual({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			status: 'active',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: { report: 'weekly' },
		});
	});

	it('returns null when no run with the id is recorded', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			runStore: new InMemoryRunStore(),
		});

		await expect(getRun('run_01MISSING')).resolves.toBeNull();
	});

	it('reads the run record through the workflow ?meta view when running on Cloudflare', async () => {
		const runIndex = new InMemoryRunStore();
		await runIndex.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		const routeRunRequest = vi.fn(async (request: Request) => {
			const url = new URL(request.url);
			expect(url.pathname).toBe('/runs/run_01DAILYREPORT');
			expect(url.searchParams.has('meta')).toBe(true);
			return Response.json({ runId: 'run_01DAILYREPORT', status: 'completed' });
		});
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [] },
			createRunIndexForRequest: () => runIndex,
			routeRunRequest,
		});

		await expect(getRun('run_01DAILYREPORT')).resolves.toEqual({
			runId: 'run_01DAILYREPORT',
			status: 'completed',
		});
		expect(routeRunRequest).toHaveBeenCalledExactlyOnceWith(expect.any(Request), undefined, {
			workflowName: 'daily-report',
			runId: 'run_01DAILYREPORT',
		});
	});
});

describe('listAgents()', () => {
	it('returns built agents from the ambient deployment manifest', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [
					{
						name: 'support',
						description: 'Resolves customer support tickets.',
						transports: { http: true },
						defined: true,
					},
					{ name: 'offline', transports: {}, defined: false },
				],
			},
		});

		await expect(listAgents()).resolves.toEqual([
			{
				name: 'support',
				description: 'Resolves customer support tickets.',
				transports: { http: true },
				defined: true,
			},
			{ name: 'offline', transports: {}, defined: false },
		]);
	});
});
