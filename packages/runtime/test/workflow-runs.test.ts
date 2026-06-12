import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlueContextInternal, FlueRuntime } from '../src/internal.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	failRecoveredRun,
	InMemoryRunStore,
	InMemorySessionStore,
} from '../src/internal.ts';
import { formatOffset } from '../src/runtime/event-stream-store.ts';
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
	it('returns accepted run stream coordinates when a workflow request uses default admission mode', async () => {
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
			const body = (await response.json()) as { runId: string; streamUrl: string; offset: string };
			runId = body.runId;

			expect(response.status).toBe(202);
			expect(body).toEqual({
				runId: expect.any(String),
				streamUrl: expect.any(String),
				offset: '-1',
			});
			expect(runId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
			// The server owns stream-coordinate derivation: the run stream lives
			// at the sibling /runs/:runId route under the same mount prefix.
			expect(body.streamUrl).toBe(`http://localhost/flue/runs/${runId}`);
			// 202 admissions mirror the DS stream-creation convention.
			expect(response.headers.get('location')).toBe(body.streamUrl);
			expect(response.headers.get('stream-next-offset')).toBe(body.offset);
			expect((await runStore.getRun(runId))?.status).toBe('active');
		} finally {
			release();
		}
		await vi.waitFor(async () => {
			expect((await runStore.getRun(runId ?? ''))?.status).toBe('completed');
		});
	});

	it('returns a flat synchronous result envelope when a workflow request uses wait result mode', async () => {
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
		const body = (await response.json()) as { result: unknown; runId: string; streamUrl: string; offset: string };

		expect(response.status).toBe(200);
		expect(body).toEqual({
			result: { delivered: true },
			runId: expect.any(String),
			streamUrl: expect.any(String),
			offset: '-1',
		});
		expect(body.runId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(body.streamUrl).toBe(`http://localhost/flue/runs/${body.runId}`);
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
		const body = (await response.json()) as { result: unknown; runId: string };

		expect(response.status).toBe(200);
		expect(body).toEqual({
			result: {
				payload: { report: 'weekly' },
				requestUrl: 'http://localhost/flue/workflows/daily-report?wait=result',
				authorization: 'Bearer test-token',
				body: { report: 'weekly' },
			},
			runId: expect.any(String),
			streamUrl: expect.any(String),
			offset: '-1',
		});
	});

	it('renders a null result when an invoked handler returns undefined', async () => {
		const runStore = new InMemoryRunStore();
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async () => undefined,
			},
			createContext,
			runStore,
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as { result: unknown; runId: string };

		expect(response.status).toBe(200);
		expect(body).toEqual({
			result: null,
			runId: expect.any(String),
			streamUrl: expect.any(String),
			offset: '-1',
		});
		const runRecord = await runStore.getRun(body.runId);
		expect(runRecord).toEqual({
			runId: body.runId,
			workflowName: 'daily-report',
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
			});

			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			const runId = (await runStore.listRuns()).runs[0]?.runId;
			expect(runId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
			const runRecord = await runStore.getRun(runId!);
			expect(runRecord).toEqual({
				runId,
				workflowName: 'daily-report',
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

	it('records an errored terminal run without an unhandled rejection when a workflow handler throws in default admission mode', async () => {
		const runStore = new InMemoryRunStore();
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
			});

			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
			);
			const body = (await response.json()) as { runId: string };

			expect(response.status).toBe(202);
			expect(body).toEqual({
				runId: expect.any(String),
				streamUrl: expect.any(String),
				offset: '-1',
			});
			// Vitest fails the run on an unhandled rejection, so waiting for the
			// terminal record also guards against the background completion
			// rejecting without a handler.
			await vi.waitFor(async () => {
				expect((await runStore.getRun(body.runId))?.status).toBe('errored');
			});
			expect(consoleError).toHaveBeenCalledWith(
				'[flue] Workflow run failed:',
				body.runId,
				expect.objectContaining({ message: 'report generation failed' }),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('excludes turn_request from the persisted run stream while delivering it in-process', async () => {
		const eventStreamStore = createTestEventStreamStore();
		const observed: string[] = [];
		const app = createApp({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			workflowHandlers: {
				'daily-report': async (ctx) => {
					const internal = ctx as unknown as FlueContextInternal;
					internal.subscribeEvent((event) => {
						observed.push(event.type);
					});
					internal.emitEvent({
						type: 'turn_request',
						turnId: 'turn-1',
						purpose: 'agent',
						model: 'reviewer',
						provider: 'faux',
						api: 'faux-chat',
						input: { systemPrompt: 'secret system prompt', messages: [] },
					});
					internal.emitEvent({ type: 'log', level: 'info', message: 'after turn_request' });
					return { delivered: true };
				},
			},
			createContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore,
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as { runId: string };

		expect(response.status).toBe(200);
		// In-process subscribers (observe(), exporters) keep full fidelity.
		expect(observed).toContain('turn_request');
		// The durable/public stream never stores or serves turn_request.
		const persisted = await eventStreamStore.readEvents(`runs/${body.runId}`, { offset: '-1' });
		const persistedTypes = persisted.events.map((entry) => (entry.data as { type: string }).type);
		expect(persistedTypes).toContain('log');
		expect(persistedTypes).not.toContain('turn_request');
		expect(JSON.stringify(persisted.events)).not.toContain('secret system prompt');
	});

	it('derives recovery event indexes from the stream head, not the event count', async () => {
		const db = new DatabaseSync(':memory:');
		const eventStreamStore = createTestEventStreamStore(db);
		const runId = 'run_01TESTRECOVERY';
		const streamPath = `runs/${runId}`;
		await eventStreamStore.createStream(streamPath);
		for (let index = 0; index < 3; index++) {
			await eventStreamStore.appendEvent(streamPath, {
				type: 'log',
				level: 'info',
				message: `m${index}`,
				runId,
				eventIndex: index,
			});
		}
		// Simulate a crash-induced gap: the head counter advanced past the
		// stored rows (UPDATE committed, INSERT lost) — four appends never
		// landed, so the stream holds 3 events but its head sits at seq 6.
		db.prepare('UPDATE flue_event_streams SET next_offset = 7 WHERE path = ?').run(streamPath);

		await failRecoveredRun({
			workflowName: 'report',
			id: runId,
			runId,
			request: new Request('http://localhost/recovery'),
			createContext,
			error: new Error('interrupted'),
			eventStreamStore,
		});

		const result = await eventStreamStore.readEvents(streamPath, { offset: '-1' });
		const recovered = result.events
			.map((entry) => ({ offset: entry.offset, data: entry.data as { type: string; eventIndex?: number } }))
			.filter((entry) => entry.data.type === 'run_resume' || entry.data.type === 'run_end');

		// Counting events would restart at index 3 and mint duplicates; the
		// head-derived index continues after the gap, keeping seq == eventIndex.
		expect(recovered).toEqual([
			{ offset: formatOffset(7), data: expect.objectContaining({ type: 'run_resume', eventIndex: 7 }) },
			{ offset: formatOffset(8), data: expect.objectContaining({ type: 'run_end', eventIndex: 8, isError: true }) },
		]);
		expect(result.closed).toBe(true);
	});

});
