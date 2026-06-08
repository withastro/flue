import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlueRuntime } from '../src/internal.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createRunSubscriberRegistry,
	failRecoveredRun,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	resetFlueRuntimeForTests,
} from '../src/internal.ts';
import { flue } from '../src/routing.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

function createContext(
	id: string,
	runId: string | undefined,
	payload: unknown,
	request: Request,
	initialEventIndex?: number,
	dispatchId?: string,
) {
	return createFlueContext({
		id,
		runId,
		dispatchId,
		payload,
		req: request,
		initialEventIndex,
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => {
			throw new Error('unexpected sandbox initialization');
		},
		defaultStore: new InMemorySessionStore(),
	});
}

function createApp(runtime: FlueRuntime): Hono {
	configureFlueRuntime(runtime);
	const app = new Hono();
	app.route('/flue', flue());
	return app;
}

function parseSseEvents(text: string): Array<{ event: string; id: string; data: unknown }> {
	return text
		.split('\n\n')
		.filter((frame) => frame.startsWith('event: '))
		.map((frame) => {
			const lines = frame.split('\n');
			return {
				event: lines[0]?.slice('event: '.length) ?? '',
				id: lines[1]?.slice('id: '.length) ?? '',
				data: JSON.parse(lines[2]?.slice('data: '.length) ?? 'null'),
			};
		});
}

describe('workflow invocation', () => {
	it('returns an accepted run id when a workflow request uses default admission mode', async () => {
		let release!: () => void;
		let runId: string | undefined;
		const completionGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runStore = new InMemoryRunStore();
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async () => {
					await completionGate;
					return { delivered: true };
				},
			},
			createContext,
			runStore,
		});

		try {
			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
			);
			const body = (await response.json()) as { status: string; runId: string };
			runId = body.runId;

			expect(response.status).toBe(202);
			expect(body).toEqual({ status: 'accepted', runId: expect.any(String) });
			expect(runId).toMatch(/^workflow:daily-report:[^:]+$/);
			expect((await runStore.getRun(runId))?.status).toBe('active');
		} finally {
			release();
		}
		await vi.waitFor(async () => {
			expect((await runStore.getRun(runId ?? ''))?.status).toBe('completed');
		});
	});

	it('returns a synchronous result envelope and run id header when a workflow request uses wait result mode', async () => {
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async () => ({ delivered: true }),
			},
			createContext,
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as { result: unknown; _meta: { runId: string } };

		expect(response.status).toBe(200);
		expect(body).toEqual({ result: { delivered: true }, _meta: { runId: expect.any(String) } });
		expect(body._meta.runId).toMatch(/^workflow:daily-report:[^:]+$/);
		expect(response.headers.get('x-flue-run-id')).toBe(body._meta.runId);
	});

	it('returns an event stream when a workflow request accepts server-sent events', async () => {
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async (ctx) => {
					ctx.log.info('report started');
					return { delivered: true };
				},
			},
			createContext,
			runStore: new InMemoryRunStore(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report', {
				method: 'POST',
				headers: { accept: 'text/event-stream' },
			}),
		);
		const runId = response.headers.get('x-flue-run-id');
		const events = parseSseEvents(await response.text());

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(runId).toMatch(/^workflow:daily-report:[^:]+$/);
		expect(events).toMatchObject([
			{
				event: 'run_start',
				id: '0',
				data: { type: 'run_start', runId, payload: {} },
			},
			{
				event: 'log',
				id: '1',
				data: { type: 'log', runId, level: 'info', message: 'report started' },
			},
			{
				event: 'run_end',
				id: '2',
				data: { type: 'run_end', runId, result: { delivered: true }, isError: false },
			},
		]);
	});

	it('rejects workflow admission before executing the handler when run-store persistence is unavailable', async () => {
		let executions = 0;
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async () => {
					executions++;
				},
			},
			createContext,
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
		);

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			error: {
				type: 'run_store_unavailable',
				message: 'Run history is not available in this runtime.',
				details: 'This endpoint requires the generated runtime to be configured with a run store.',
			},
		});
		expect(response.headers.get('x-flue-run-id')).toMatch(/^workflow:daily-report:[^:]+$/);
		expect(executions).toBe(0);
	});

	it('rejects workflow admission before executing the handler when createRun() fails', async () => {
		let executions = 0;
		const runStore = new InMemoryRunStore();
		vi.spyOn(runStore, 'createRun').mockRejectedValue(new Error('run store unavailable'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const app = createApp({
				target: 'node',
				manifest: {
					agents: [],
					workflows: [{ name: 'daily-report', transports: { http: true } }],
				},
				workflowHandlers: {
					'daily-report': async () => {
						executions++;
					},
				},
				createContext,
				runStore,
			});

			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(response.headers.get('x-flue-run-id')).toMatch(/^workflow:daily-report:[^:]+$/);
			expect(executions).toBe(0);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('preserves request payload and request access when a workflow handler executes', async () => {
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async (ctx) => ({
					payload: ctx.payload,
					requestUrl: ctx.req?.url,
					authorization: ctx.req?.headers.get('authorization'),
					body: await ctx.req?.json(),
				}),
			},
			createContext,
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', {
				method: 'POST',
				headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
				body: JSON.stringify({ report: 'weekly' }),
			}),
		);
		const body = (await response.json()) as { result: unknown; _meta: { runId: string } };

		expect(response.status).toBe(200);
		expect(body).toEqual({
			result: {
				payload: { report: 'weekly' },
				requestUrl: 'http://localhost/flue/workflows/daily-report?wait=result',
				authorization: 'Bearer test-token',
				body: { report: 'weekly' },
			},
			_meta: { runId: expect.any(String) },
		});
	});

	it('renders a null result when an invoked handler returns undefined', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async () => undefined,
			},
			createContext,
			runStore,
			runRegistry,
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as { result: unknown; _meta: { runId: string } };
		const runResponse = await app.fetch(
			new Request(`http://localhost/flue/runs/${encodeURIComponent(body._meta.runId)}`),
		);

		expect(response.status).toBe(200);
		expect(body).toEqual({ result: null, _meta: { runId: expect.any(String) } });
		expect(runResponse.status).toBe(200);
		expect(await runResponse.json()).toEqual({
			runId: body._meta.runId,
			owner: {
				kind: 'workflow',
				workflowName: 'daily-report',
				instanceId: body._meta.runId,
			},
			status: 'completed',
			startedAt: expect.any(String),
			payload: {},
			endedAt: expect.any(String),
			isError: false,
			durationMs: expect.any(Number),
			result: null,
		});
	});
});

describe('workflow run lifecycle', () => {
	it('persists run_start before and run_end after nested workflow activity when a workflow completes', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async (ctx) => {
					ctx.log.info('building report');
					return { delivered: true };
				},
			},
			createContext,
			runStore,
			runRegistry,
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as { result: unknown; _meta: { runId: string } };
		const eventsResponse = await app.fetch(
			new Request(`http://localhost/flue/runs/${encodeURIComponent(body._meta.runId)}/events`),
		);
		const eventsBody = (await eventsResponse.json()) as { events: unknown[] };

		expect(eventsResponse.status).toBe(200);
		expect(eventsBody).toMatchObject({
			events: [
				{ type: 'run_start', runId: body._meta.runId, eventIndex: 0, payload: {} },
				{
					type: 'log',
					runId: body._meta.runId,
					eventIndex: 1,
					level: 'info',
					message: 'building report',
				},
				{
					type: 'run_end',
					runId: body._meta.runId,
					eventIndex: 2,
					result: { delivered: true },
					isError: false,
				},
			],
		});
	});

	it('records an errored terminal run when a workflow handler throws', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const app = createApp({
				target: 'node',
				manifest: {
					agents: [],
					workflows: [{ name: 'daily-report', transports: { http: true } }],
				},
				workflowHandlers: {
					'daily-report': async () => {
						throw new Error('report generation failed');
					},
				},
				createContext,
				runStore,
				runRegistry,
			});

			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
			);
			const runId = response.headers.get('x-flue-run-id');
			const runResponse = await app.fetch(
				new Request(`http://localhost/flue/runs/${encodeURIComponent(runId ?? '')}`),
			);
			const eventsResponse = await app.fetch(
				new Request(`http://localhost/flue/runs/${encodeURIComponent(runId ?? '')}/events`),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(runId).toMatch(/^workflow:daily-report:[^:]+$/);
			expect(runResponse.status).toBe(200);
			expect(await runResponse.json()).toEqual({
				runId,
				owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: runId },
				status: 'errored',
				startedAt: expect.any(String),
				payload: {},
				endedAt: expect.any(String),
				isError: true,
				durationMs: expect.any(Number),
				error: { name: 'Error', message: 'report generation failed' },
			});
			expect(eventsResponse.status).toBe(200);
			expect(await eventsResponse.json()).toMatchObject({
				events: [
					{ type: 'run_start', runId, eventIndex: 0 },
					{
						type: 'run_end',
						runId,
						eventIndex: 1,
						isError: true,
						error: { name: 'Error', message: 'report generation failed' },
					},
				],
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('preserves an explicit null terminal result when recovery finalizes an active workflow run', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:recovered';
		const owner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: runId };
		await runStore.createRun({
			runId,
			owner,
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
		});
		await runStore.appendEvent(runId, {
			type: 'run_end',
			runId,
			result: null,
			isError: false,
			durationMs: 1000,
			eventIndex: 0,
			timestamp: '2026-06-02T00:00:01.000Z',
		});

		await failRecoveredRun({
			owner,
			id: runId,
			runId,
			request: new Request('http://localhost/flue/workflows/daily-report'),
			createContext,
			error: new Error('interrupted'),
			runStore,
			runRegistry,
		});

		expect(await runStore.getRun(runId)).toMatchObject({
			status: 'completed',
			result: null,
		});
	});

	it('emits recovery handling before terminalizing an admitted workflow without a persisted start event', async () => {
		const runStore = new InMemoryRunStore();
		const runId = 'workflow:daily-report:recovery-before-start';
		const owner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: runId };
		await runStore.createRun({
			runId,
			owner,
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
		});

		await failRecoveredRun({
			owner,
			id: runId,
			runId,
			request: new Request('http://localhost/flue/workflows/daily-report'),
			createContext,
			error: new Error('interrupted'),
			runStore,
		});

		expect(
			(await runStore.getEvents(runId)).map((event) => [event.type, event.eventIndex]),
		).toEqual([
			['run_resume', 0],
			['run_end', 1],
		]);
	});

	it('continues recovery event indexes after the maximum persisted workflow index', async () => {
		const runStore = new InMemoryRunStore();
		const runId = 'workflow:daily-report:recovery-index';
		const owner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: runId };
		await runStore.createRun({
			runId,
			owner,
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: undefined,
		});
		await runStore.appendEvent(runId, {
			type: 'run_start',
			runId,
			owner,
			instanceId: runId,
			workflowName: 'daily-report',
			startedAt: '2026-06-02T00:00:00.000Z',
			payload: {},
			eventIndex: 4,
		});

		await failRecoveredRun({
			owner,
			id: runId,
			runId,
			request: new Request('http://localhost/flue/workflows/daily-report'),
			createContext,
			error: new Error('interrupted'),
			runStore,
		});

		expect(
			(await runStore.getEvents(runId)).map((event) => [event.type, event.eventIndex]),
		).toEqual([
			['run_start', 4],
			['run_resume', 5],
			['run_end', 6],
		]);
	});

	it('delivers run_end before closing an active workflow event stream when execution completes', async () => {
		let release!: () => void;
		const completionGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runStore = new InMemoryRunStore();
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async (ctx) => {
					ctx.log.info('waiting for report');
					await completionGate;
					return { delivered: true };
				},
			},
			createContext,
			runStore,
			runSubscribers: createRunSubscriberRegistry(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report', {
				method: 'POST',
				headers: { accept: 'text/event-stream' },
			}),
		);
		try {
			await vi.waitFor(() => {
				expect(response.headers.get('x-flue-run-id')).toMatch(/^workflow:daily-report:[^:]+$/);
			});
		} finally {
			release();
		}
		const events = parseSseEvents(await response.text());
		const runId = response.headers.get('x-flue-run-id');

		expect(events).toMatchObject([
			{ event: 'run_start', id: '0', data: { type: 'run_start', runId } },
			{
				event: 'log',
				id: '1',
				data: { type: 'log', runId, level: 'info', message: 'waiting for report' },
			},
			{
				event: 'run_end',
				id: '2',
				data: { type: 'run_end', runId, result: { delivered: true }, isError: false },
			},
		]);
		expect(events.at(-1)).toMatchObject({ event: 'run_end', data: { type: 'run_end', runId } });
	});
});
