import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { WorkflowInvokeRequest } from '../src/index.ts';
import {
	defineAgent,
	defineWorkflow,
	invoke,
	WorkflowAdmissionError,
	WorkflowInputSerializationError,
	WorkflowInputUnexpectedError,
	WorkflowInvocationNotConfiguredError,
	WorkflowNotDiscoveredError,
} from '../src/index.ts';
import {
	admitDetachedWorkflow,
	configureFlueRuntime,
	createFlueContext,
	failRecoveredRun,
	handleWorkflowRequest,
	InMemoryRunStore,
	InMemorySessionStore,
} from '../src/internal.ts';
import { flue } from '../src/routing.ts';
import { formatOffset } from '../src/runtime/event-stream-store.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { nodeRuntime, workflowRecord } from './helpers/runtime-config.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

function createContext({
	runId,
	request,
	initialEventIndex,
}: {
	runId: string;
	request: Request;
	initialEventIndex?: number;
}) {
	return createFlueContext({
		id: runId,
		runId,
		req: request,
		initialEventIndex,
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		defaultStore: new InMemorySessionStore(),
	});
}

function httpWorkflowRecord(
	name: string,
	definition: import('../src/internal.ts').WorkflowRecord['definition'],
) {
	return workflowRecord(name, definition, { route: async (_c, next) => next() });
}

function workflow(run: (input: unknown) => any) {
	return defineWorkflow({
		agent: defineAgent(() => ({ model: false })),
		input: v.looseObject({}),
		async run({ input }) {
			return run(input);
		},
	});
}

function createApp(runtime: Partial<import('../src/internal.ts').NodeRuntime>): Hono {
	configureFlueRuntime(nodeRuntime({ eventStreamStore: createTestEventStreamStore(), ...runtime }));
	const app = new Hono();
	app.route('/flue', flue());
	return app;
}

describe('invoke()', () => {
	it('infers caller input from Workflow Action input semantics', () => {
		const required = defineWorkflow({
			agent: defineAgent(() => ({ model: false })),
			input: v.object({ count: v.number() }),
			run: async ({ input }) => input,
		});
		const omitted = defineWorkflow({
			agent: defineAgent(() => ({ model: false })),
			run: async () => undefined,
		});

		expectTypeOf(invoke).toBeCallableWith(required, { input: { count: 1 } });
		expectTypeOf(invoke).toBeCallableWith(omitted, {});
		expectTypeOf<{ input: Record<never, never> }>().not.toMatchTypeOf<
			WorkflowInvokeRequest<typeof omitted>
		>();
	});

	it('rejects supplied input when a Workflow Action declares no input', async () => {
		const target = defineWorkflow({
			agent: defineAgent(() => ({ model: false })),
			run: async () => undefined,
		});
		const admitWorkflow = vi.fn(async () => ({ runId: 'run_no_input' }));
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('target', target)],
				admitWorkflow,
			}),
		);

		await expect(invoke(target, { input: {} } as never)).rejects.toBeInstanceOf(
			WorkflowInputUnexpectedError,
		);
		expect(admitWorkflow).not.toHaveBeenCalled();
	});

	it('rejects calls when ambient workflow admission is unconfigured', async () => {
		const target = workflow(async () => undefined);

		await expect(invoke(target, { input: {} })).rejects.toBeInstanceOf(
			WorkflowInvocationNotConfiguredError,
		);
	});

	it('rejects Workflow Definitions that are not exact discovered identities', async () => {
		const discovered = workflow(async () => undefined);
		const undiscovered = workflow(async () => undefined);
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('discovered', discovered)],
				admitWorkflow: async () => ({ runId: 'run_discovered' }),
			}),
		);

		await expect(invoke(undiscovered, { input: {} })).rejects.toBeInstanceOf(
			WorkflowNotDiscoveredError,
		);
	});

	it('strictly snapshots caller input before admission', async () => {
		const target = workflow(async () => undefined);
		const admitted: unknown[] = [];
		const input = { nested: { count: 1 } };
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('target', target)],
				admitWorkflow: async (admission) => {
					admitted.push(admission.input);
					return { runId: 'run_snapshot' };
				},
			}),
		);

		await invoke(target, { input });
		input.nested.count = 2;

		expect(admitted).toEqual([{ nested: { count: 1 } }]);
		await expect(invoke(target, { input: { invalid: 1n } } as never)).rejects.toBeInstanceOf(
			WorkflowInputSerializationError,
		);
	});

	it('wraps target admission failures in a structured public error', async () => {
		const target = workflow(async () => undefined);
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('target', target)],
				admitWorkflow: async () => {
					throw new Error('storage unavailable');
				},
			}),
		);

		await expect(invoke(target, { input: {} })).rejects.toBeInstanceOf(WorkflowAdmissionError);
	});

	it('returns after persisted admission and before detached completion', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const target = workflow(async () => {
			await gate;
			return { done: true };
		});
		const runStore = new InMemoryRunStore();
		const eventStreamStore = createTestEventStreamStore();
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('target', target)],
				admitWorkflow: ({ workflowName, input }) =>
					admitDetachedWorkflow({
						workflowName,
						workflow: target,
						input,
						request: new Request('https://flue.invalid/_internal/workflow', { method: 'POST' }),
						createContext,
						runStore,
						eventStreamStore,
					}),
			}),
		);

		const receipt = await invoke(target, { input: { report: 'weekly' } });
		expect(await runStore.getRun(receipt.runId)).toMatchObject({
			status: 'active',
			input: { report: 'weekly' },
		});
		expect(await eventStreamStore.getStreamMeta(`runs/${receipt.runId}`)).toBeDefined();
		release();
		await vi.waitFor(async () => {
			expect((await runStore.getRun(receipt.runId))?.status).toBe('completed');
		});
	});

	it('terminalizes before rejecting when detached scheduling fails before execution starts', async () => {
		const target = workflow(async () => undefined);
		const runStore = new InMemoryRunStore();
		const eventStreamStore = createTestEventStreamStore();
		const runId = 'run_scheduling_failure';

		await expect(
			admitDetachedWorkflow({
				workflowName: 'target',
				runId,
				workflow: target,
				input: {},
				request: new Request('https://flue.invalid/_internal/workflow', { method: 'POST' }),
				createContext,
				runStore,
				eventStreamStore,
				startWorkflowAdmission: () => ({
					admitted: Promise.reject(new Error('fiber rejected before scheduling')),
					completion: new Promise(() => undefined),
				}),
			}),
		).rejects.toThrow('fiber rejected before scheduling');

		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true });
		const stream = await eventStreamStore.readEvents(`runs/${runId}`, { offset: '-1' });
		expect(stream.events.map((event) => (event.data as { type: string }).type)).toEqual([
			'run_end',
		]);
		expect(stream.closed).toBe(true);
	});

	it('returns a detached receipt when completion fails after admission', async () => {
		const target = workflow(async () => undefined);
		const runStore = new InMemoryRunStore();
		const eventStreamStore = createTestEventStreamStore();
		const runId = 'run_completion_failure';
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			await expect(
				admitDetachedWorkflow({
					workflowName: 'target',
					runId,
					workflow: target,
					input: {},
					request: new Request('https://flue.invalid/_internal/workflow', { method: 'POST' }),
					createContext,
					runStore,
					eventStreamStore,
					startWorkflowAdmission: () => ({
						admitted: Promise.resolve(),
						completion: Promise.reject(new Error('fiber failed after admission')),
					}),
				}),
			).resolves.toEqual({ runId });
			await vi.waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(
					'[flue] Workflow run failed:',
					runId,
					expect.objectContaining({ message: 'fiber failed after admission' }),
				);
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('waits for completion after admission in synchronous mode', async () => {
		let release!: (value: unknown) => void;
		const completion = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		const request = new Request('http://localhost/flue/workflows/daily-report?wait=result', {
			method: 'POST',
		});
		const responsePromise = handleWorkflowRequest({
			request,
			workflowName: 'daily-report',
			workflow: workflow(async () => undefined),
			createContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore: createTestEventStreamStore(),
			startWorkflowAdmission: () => ({ admitted: Promise.resolve(), completion }),
		});
		let settled = false;
		responsePromise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release({ delivered: true });
		const response = await responsePromise;
		expect(await response.json()).toMatchObject({ result: { delivered: true } });
	});

	it('terminalizes the run when event stream creation fails after run persistence', async () => {
		const target = workflow(async () => undefined);
		const runStore = new InMemoryRunStore();
		const eventStreamStore = createTestEventStreamStore();
		vi.spyOn(eventStreamStore, 'createStream').mockRejectedValue(new Error('stream unavailable'));
		const appendEvent = vi.spyOn(eventStreamStore, 'appendEvent');
		const closeStream = vi.spyOn(eventStreamStore, 'closeStream');
		const runId = 'run_stream_creation_failure';

		await expect(
			admitDetachedWorkflow({
				workflowName: 'target',
				runId,
				workflow: target,
				input: {},
				request: new Request('https://flue.invalid/_internal/workflow', { method: 'POST' }),
				createContext,
				runStore,
				eventStreamStore,
			}),
		).rejects.toThrow('stream unavailable');

		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true });
		expect(appendEvent).not.toHaveBeenCalled();
		expect(closeStream).not.toHaveBeenCalled();
	});

	it('records detached workflow failures without rejecting the admission receipt', async () => {
		const target = workflow(async () => {
			throw new Error('detached failure');
		});
		const runStore = new InMemoryRunStore();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		configureFlueRuntime(
			nodeRuntime({
				target: 'node',
				workflows: [httpWorkflowRecord('target', target)],
				admitWorkflow: ({ workflowName, input }) =>
					admitDetachedWorkflow({
						workflowName,
						workflow: target,
						input,
						request: new Request('https://flue.invalid/_internal/workflow', { method: 'POST' }),
						createContext,
						runStore,
						eventStreamStore: createTestEventStreamStore(),
					}),
			}),
		);

		try {
			const receipt = await invoke(target, { input: {} });
			await vi.waitFor(async () => {
				expect((await runStore.getRun(receipt.runId))?.status).toBe('errored');
			});
		} finally {
			consoleError.mockRestore();
		}
	});
});

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

			workflows: [
				httpWorkflowRecord(
					'daily-report',
					workflow(async () => {
						await completionGate;
						return { delivered: true };
					}),
				),
			],
			createWorkflowContext: createContext,
			runStore,
		});

		try {
			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
			);
			const body = (await response.json()) as { runId: string };
			runId = body.runId;

			expect(response.status).toBe(202);
			expect(body).toEqual({ runId: expect.any(String) });
			expect(runId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
			expect(response.headers.get('location')).toBeNull();
			expect(response.headers.get('stream-next-offset')).toBeNull();
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

			workflows: [
				httpWorkflowRecord(
					'daily-report',
					workflow(async () => ({ delivered: true })),
				),
			],
			createWorkflowContext: createContext,
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', { method: 'POST' }),
		);
		const body = (await response.json()) as {
			result: unknown;
			runId: string;
		};

		expect(response.status).toBe(200);
		expect(body).toEqual({
			result: { delivered: true },
			runId: expect.any(String),
		});
		expect(body.runId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	it('rejects workflow admission before executing the handler when run-store persistence is unavailable', async () => {
		let executions = 0;
		const app = createApp({
			target: 'node',

			workflows: [
				httpWorkflowRecord(
					'daily-report',
					workflow(async () => {
						executions++;
					}),
				),
			],
			createWorkflowContext: createContext,
			runStore: undefined,
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

				workflows: [
					httpWorkflowRecord(
						'daily-report',
						workflow(async () => {
							executions++;
						}),
					),
				],
				createWorkflowContext: createContext,
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

	it('passes request body through Action input after route middleware runs', async () => {
		const middleware = vi.fn(async (_c, next) => next());
		const app = createApp({
			target: 'node',

			workflows: [
				workflowRecord(
					'daily-report',
					workflow(async (input) => ({ input })),
					{ route: middleware },
				),
			],

			createWorkflowContext: createContext,
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/daily-report?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ report: 'weekly' }),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ result: { input: { report: 'weekly' } } });
		expect(middleware).toHaveBeenCalledOnce();
	});

	it('rejects invalid Action input before initializing the workflow Agent or sandbox', async () => {
		const initialize = vi.fn(() => ({ model: false as const }));
		const createSessionEnv = vi.fn(async () => createNoopSessionEnv());
		const invalidWorkflow = defineWorkflow({
			agent: defineAgent(initialize),
			input: v.object({ count: v.number() }),
			run: async ({ input }) => input,
		});
		const app = createApp({
			target: 'node',

			workflows: [httpWorkflowRecord('validated', invalidWorkflow)],
			createWorkflowContext({ runId, request }) {
				return createFlueContext({
					id: runId,
					runId,
					req: request,
					env: {},
					agentConfig: { resolveModel: () => undefined },
					createDefaultEnv: createSessionEnv,
					defaultStore: new InMemorySessionStore(),
				});
			},
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/validated?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ count: 'invalid' }),
			}),
		);

		expect(response.status).toBe(500);
		expect(initialize).not.toHaveBeenCalled();
		expect(createSessionEnv).not.toHaveBeenCalled();
	});

	it('rejects explicit input for a no-input workflow before initializing its Agent or sandbox', async () => {
		const initialize = vi.fn(() => ({ model: false as const }));
		const createSessionEnv = vi.fn(async () => createNoopSessionEnv());
		const noInputWorkflow = defineWorkflow({
			agent: defineAgent(initialize),
			run: async () => undefined,
		});
		const app = createApp({
			target: 'node',

			workflows: [httpWorkflowRecord('no-input', noInputWorkflow)],
			createWorkflowContext({ runId, request }) {
				return createFlueContext({
					id: runId,
					runId,
					req: request,
					env: {},
					agentConfig: { resolveModel: () => undefined },
					createDefaultEnv: createSessionEnv,
					defaultStore: new InMemorySessionStore(),
				});
			},
			runStore: new InMemoryRunStore(),
		});

		const response = await app.fetch(
			new Request('http://localhost/flue/workflows/no-input?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { type: 'workflow_input_unexpected' } });
		expect(initialize).not.toHaveBeenCalled();
		expect(createSessionEnv).not.toHaveBeenCalled();
	});

	it('renders a null result when an invoked handler returns undefined', async () => {
		const runStore = new InMemoryRunStore();
		const app = createApp({
			target: 'node',

			workflows: [
				httpWorkflowRecord(
					'daily-report',
					workflow(async () => undefined),
				),
			],
			createWorkflowContext: createContext,
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
		});
		const runRecord = await runStore.getRun(body.runId);
		expect(runRecord).toEqual({
			runId: body.runId,
			workflowName: 'daily-report',
			status: 'completed',
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			isError: false,
			durationMs: expect.any(Number),
			input: undefined,
			result: null,
			error: undefined,
		});
	});
});

describe('workflow run lifecycle', () => {
	it('waits for an unawaited Session operation to settle after abort before completing the run', async () => {
		let markStarted!: () => void;
		let markAborted!: () => void;
		let releaseSettlement!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve;
		});
		const settlementGate = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		let operationSettled = false;
		const runStore = new InMemoryRunStore();
		const eventStreamStore = createTestEventStreamStore();
		const createdWorkflow = defineWorkflow({
			agent: defineAgent(() => ({ model: false })),
			async run({ harness }) {
				const session = await harness.session();
				void session.shell('slow operation');
				await started;
				return { delivered: true };
			},
		});
		const app = createApp({
			target: 'node',

			workflows: [httpWorkflowRecord('cleanup', createdWorkflow)],
			createWorkflowContext({ runId, request }) {
				return createFlueContext({
					id: runId,
					runId,
					req: request,
					env: {},
					agentConfig: { resolveModel: () => undefined },
					createDefaultEnv: async () =>
						createNoopSessionEnv({
							async exec(_command, options) {
								markStarted();
								if (!options?.signal?.aborted) {
									await new Promise<void>((resolve) =>
										options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
									);
								}
								markAborted();
								await settlementGate;
								operationSettled = true;
								throw new DOMException('aborted', 'AbortError');
							},
						}),
					defaultStore: new InMemorySessionStore(),
				});
			},
			runStore,
			eventStreamStore,
		});

		let responseSettled = false;
		const responsePromise = Promise.resolve(
			app.fetch(
				new Request('http://localhost/flue/workflows/cleanup?wait=result', { method: 'POST' }),
			),
		).finally(() => {
			responseSettled = true;
		});
		await aborted;
		const activeRun = (await runStore.listRuns()).runs[0];
		expect(activeRun?.status).toBe('active');
		expect(responseSettled).toBe(false);
		expect(operationSettled).toBe(false);

		releaseSettlement();
		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(operationSettled).toBe(true);
		if (!activeRun) throw new Error('Expected an admitted run.');
		expect((await runStore.getRun(activeRun.runId))?.status).toBe('completed');
		const persisted = await eventStreamStore.readEvents(`runs/${activeRun.runId}`, {
			offset: '-1',
		});
		const types = persisted.events.map((entry) => (entry.data as { type: string }).type);
		expect(types.at(-1)).toBe('run_end');
		expect(persisted.events[0]?.data).toMatchObject({ type: 'run_start' });
		expect(persisted.events[0]?.data).not.toHaveProperty('input');
		expect(persisted.events[0]?.data).not.toHaveProperty('payload');
		expect(types.lastIndexOf('operation')).toBeLessThan(types.lastIndexOf('run_end'));
		expect(persisted.closed).toBe(true);
		const eventCount = persisted.events.length;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			(await eventStreamStore.readEvents(`runs/${activeRun.runId}`, { offset: '-1' })).events,
		).toHaveLength(eventCount);
	});

	it('records an errored terminal run when a workflow handler throws', async () => {
		const runStore = new InMemoryRunStore();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const app = createApp({
				target: 'node',

				workflows: [
					httpWorkflowRecord(
						'daily-report',
						workflow(async () => {
							throw new Error('report generation failed');
						}),
					),
				],
				createWorkflowContext: createContext,
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
			if (!runId) throw new Error('Expected an errored run record.');
			const runRecord = await runStore.getRun(runId);
			expect(runRecord).toEqual({
				runId,
				workflowName: 'daily-report',
				status: 'errored',
				startedAt: expect.any(String),
				endedAt: expect.any(String),
				isError: true,
				durationMs: expect.any(Number),
				input: undefined,
				result: undefined,
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

				workflows: [
					httpWorkflowRecord(
						'daily-report',
						workflow(async () => {
							throw new Error('report generation failed');
						}),
					),
				],
				createWorkflowContext: createContext,
				runStore,
			});

			const response = await app.fetch(
				new Request('http://localhost/flue/workflows/daily-report', { method: 'POST' }),
			);
			const body = (await response.json()) as { runId: string };

			expect(response.status).toBe(202);
			expect(body).toEqual({ runId: expect.any(String) });
			// Vitest fails the run on an unhandled rejection, so waiting for the
			// terminal record also guards against the background completion
			// rejecting without a handler.
			await vi.waitFor(async () => {
				expect((await runStore.getRun(body.runId))?.status).toBe('errored');
				expect(consoleError).toHaveBeenCalledWith(
					'[flue] Workflow run failed:',
					body.runId,
					expect.objectContaining({ message: 'report generation failed' }),
				);
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

	it('normalizes legacy persisted run_start payloads during recovery', async () => {
		const eventStreamStore = createTestEventStreamStore();
		const runStore = new InMemoryRunStore();
		const runId = 'run_legacy_recovery';
		const streamPath = `runs/${runId}`;
		await eventStreamStore.createStream(streamPath);
		await eventStreamStore.appendEvent(streamPath, {
			type: 'run_start',
			v: 1,
			runId,
			workflowName: 'report',
			startedAt: '2026-06-19T00:00:00.000Z',
			payload: { report: 'weekly' },
		});

		await failRecoveredRun({
			workflowName: 'report',
			runId,
			request: new Request('http://localhost/recovery'),
			createContext,
			error: new Error('interrupted'),
			runStore,
			eventStreamStore,
		});

		expect(await runStore.getRun(runId)).toMatchObject({
			status: 'errored',
			input: { report: 'weekly' },
		});
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
			runId,
			request: new Request('http://localhost/recovery'),
			createContext,
			error: new Error('interrupted'),
			eventStreamStore,
		});

		const result = await eventStreamStore.readEvents(streamPath, { offset: '-1' });
		const recovered = result.events
			.map((entry) => ({
				offset: entry.offset,
				data: entry.data as { type: string; eventIndex?: number },
			}))
			.filter((entry) => entry.data.type === 'run_resume' || entry.data.type === 'run_end');

		// Counting events would restart at index 3 and mint duplicates; the
		// head-derived index continues after the gap, keeping seq == eventIndex.
		expect(recovered).toEqual([
			{
				offset: formatOffset(7),
				data: expect.objectContaining({ type: 'run_resume', eventIndex: 7 }),
			},
			{
				offset: formatOffset(8),
				data: expect.objectContaining({ type: 'run_end', eventIndex: 8, isError: true }),
			},
		]);
		expect(result.closed).toBe(true);
	});
});
