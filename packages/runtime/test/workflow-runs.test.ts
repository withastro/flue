import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlueRuntime } from '../src/internal.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
} from '../src/internal.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { flue } from '../src/routing.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

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
	configureFlueRuntime({ eventStreamStore: createTestEventStreamStore(), ...runtime });
	const app = new Hono();
	app.route('/flue', flue());
	return app;
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

		expect(response.status).toBe(200);
		expect(body).toEqual({ result: null, _meta: { runId: expect.any(String) } });
		const runRecord = await runStore.getRun(body._meta.runId);
		expect(runRecord).toEqual({
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

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(runId).toMatch(/^workflow:daily-report:[^:]+$/);
			const runRecord = await runStore.getRun(runId!);
			expect(runRecord).toEqual({
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
		} finally {
			consoleError.mockRestore();
		}
	});

});
