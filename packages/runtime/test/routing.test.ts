import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFlueContext } from '../src/client.ts';
import { ModelNotConfiguredError } from '../src/errors.ts';
import { defineAgent, defineWorkflow } from '../src/index.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { MAX_IMAGE_DATA_LENGTH } from '../src/persisted-images.ts';
import {
	configureFlueRuntime,
	createDefaultFlueApp,
	flue,
	resetFlueRuntimeForTests,
} from '../src/runtime/flue-app.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { agentRecord, cloudflareRuntime, nodeRuntime, workflowRecord } from './helpers/runtime-config.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('flue()', () => {
	it('serves a discovered channel handler beneath the flue mount prefix', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				slack: {
					'POST /events': async (c) =>
						c.json({
							path: c.req.path,
							team: c.req.query('team'),
						}),
				},
			},
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/channels/slack/events?team=T123', {
				method: 'POST',
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: '/api/channels/slack/events',
			team: 'T123',
		});
	});

	it('serves a channel response when it comes from another JavaScript realm', async () => {
		const nativeResponse = new Response('accepted', { status: 202 });
		const response = new Proxy(nativeResponse, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
			getPrototypeOf() {
				return null;
			},
		});
		expect(response).not.toBeInstanceOf(Response);
		expect(Object.prototype.toString.call(response)).toBe('[object Response]');

		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				slack: {
					'POST /events': async () => response,
				},
			},
		}));
		const app = new Hono();
		app.route('/', flue());

		const result = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'POST' }),
		);

		expect(result.status).toBe(202);
		expect(await result.text()).toBe('accepted');
	});

	it('rejects a tagged object when a channel handler does not return a Fetch response', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				slack: {
					'POST /events': async () => ({ [Symbol.toStringTag]: 'Response' }) as unknown as Response,
				},
			},
		}));
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'POST' }),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { type: 'internal_error' },
		});
	});

	it('serves an explicit channel HEAD route with the original request method', async () => {
		const handler = vi.fn(async (c) => {
			expect(c.req.method).toBe('HEAD');
			return new Response(null, {
				status: 204,
				headers: { 'x-endpoint-validation': 'accepted' },
			});
		});
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				intercom: {
					'HEAD /webhook': handler,
				},
			},
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/channels/intercom/webhook', {
				method: 'HEAD',
			}),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('x-endpoint-validation')).toBe('accepted');
		expect(handler).toHaveBeenCalledOnce();
	});

	it('returns method_not_allowed for a configured channel path with the wrong method', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				slack: {
					'POST /events': async (c) => c.body(null, 200),
					'PUT /events': async (c) => c.body(null, 202),
				},
			},
		}));
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'GET' }),
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST, PUT');
	});

	it('serves channel route suffixes with multiple path segments', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				custom: {
					'POST /webhooks/retries': async (c) => c.text(c.req.param('suffix') ?? ''),
				},
			},
		}));
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/channels/custom/webhooks/retries', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('webhooks/retries');
	});

	it('does not serve the top-level channel namespace or an unknown suffix', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			channelHandlers: {
				slack: {
					'POST /events': async (c) => c.body(null, 200),
				},
			},
		}));
		const app = new Hono();
		app.route('/', flue());

		const rootResponse = await app.fetch(
			new Request('http://localhost/channels/slack', { method: 'POST' }),
		);
		const unknownResponse = await app.fetch(
			new Request('http://localhost/channels/slack/unknown', { method: 'POST' }),
		);

		expect(rootResponse.status).toBe(404);
		expect(unknownResponse.status).toBe(404);
	});

	it('returns 404 when the removed public OpenAPI route is requested', async () => {
		configureFlueRuntime(nodeRuntime({ target: 'node' }));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/openapi.json'));

		expect(response.status).toBe(404);
	});

	it('invokes an HTTP-exposed agent when the mounted app receives a valid agent POST', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			streamUrl: 'http://localhost/api/agents/assistant/customer-123',
			offset: '-1',
			submissionId: 'submission-1',
		});
		// 202 admissions mirror the DS stream-creation convention.
		expect(response.headers.get('location')).toBe(
			'http://localhost/api/agents/assistant/customer-123',
		);
		expect(response.headers.get('stream-next-offset')).toBe('-1');
	});

	it('accepts direct agent images and delivers them unchanged', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, ) => async (payload) => ({ submissionId: 'submission-1', result: payload }),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());
		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					message: 'hello',
					images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png', ignored: true }],
					ignored: true,
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toMatchObject({
			result: {
				message: 'hello',
				images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			},
		});
	});

	it('returns the synchronous result envelope when an agent POST requests wait=result', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123?wait=result', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			result: { instanceId: 'customer-123', payload: { message: 'hello' } },
			streamUrl: 'http://localhost/api/agents/assistant/customer-123',
			offset: '-1',
			submissionId: 'submission-1',
		});
	});

	it('renders the typed error envelope when a session FlueError fails a synchronous agent POST', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, ) => async () => {
					throw new ModelNotConfiguredError({ callSite: 'this prompt() call' });
				},
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		try {
			const response = await app.fetch(
				new Request('http://localhost/api/agents/assistant/customer-123?wait=result', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'hello' }),
				}),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'model_not_configured',
					message: 'No model is configured for this prompt() call.',
					details: '',
				},
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it('rejects an unknown wait value with invalid_request when an agent POST mistypes the query', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123?wait=results', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'invalid_request',
		);
	});

	it('rejects an unknown wait value with invalid_request when a workflow POST mistypes the query', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [
				workflowRecord(
					'daily-report',
					defineWorkflow({
						agent: defineAgent(() => ({ model: false })),
						run: async () => ({ delivered: true }),
					}),
					{ route: async (_c, next) => next() },
				),
			],
			createWorkflowContext: createTestContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/daily-report?wait=results', { method: 'POST' }),
		);

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
			'invalid_request',
		);
	});

	it("keeps the agent stream unreadable when the instance's only prompt fails admission", async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, ) => async () => {
					throw new Error('[flue] runtime is shutting down; new submissions are not accepted.');
				},
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		try {
			const prompt = await app.fetch(
				new Request('http://localhost/api/agents/assistant/customer-123', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'hello' }),
				}),
			);
			expect(prompt.status).toBe(500);

			// No prompt was ever admitted, so the stream must not exist:
			// reads return the documented 404, not an open empty stream.
			const read = await app.fetch(
				new Request('http://localhost/api/agents/assistant/customer-123'),
			);
			expect(read.status).toBe(404);
			expect(((await read.json()) as { error: { type: string } }).error.type).toBe(
				'stream_not_found',
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('rejects non-POST agent requests with a method envelope when a path targets an HTTP agent', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', { method: 'DELETE' }),
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
		expect(await response.json()).toEqual({
			error: {
				type: 'method_not_allowed',
				message: 'HTTP method DELETE is not allowed on this endpoint.',
				details: 'This endpoint accepts "GET", "HEAD", "POST" only.',
			},
		});
	});

	it('rejects non-POST workflow requests with a method envelope when a path targets an HTTP workflow', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { route: async (_c, next) => next() })],
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/daily-report', { method: 'PATCH' }),
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
		expect(await response.json()).toEqual({
			error: {
				type: 'method_not_allowed',
				message: 'HTTP method PATCH is not allowed on this endpoint.',
				details: 'This endpoint accepts "POST" only.',
			},
		});
	});

	it('omits registered sibling names in production when an unknown agent is requested', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			devMode: false,
			agents: [agentRecord('private-support', { route: async (_c, next) => next() })],
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/missing/customer-123', { method: 'POST' }),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				type: 'agent_not_found',
				message: 'Agent "missing" is not registered.',
				details: 'Verify the agent name is correct.',
			},
		});
	});

	it('includes developer guidance in dev mode when an unknown agent is requested', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			devMode: true,
			agents: [agentRecord('private-support', { route: async (_c, next) => next() })],
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/missing/customer-123', { method: 'POST' }),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				type: 'agent_not_found',
				message: 'Agent "missing" is not registered.',
				details: 'Verify the agent name is correct.',
				dev: 'Available agents: "private-support".\nAgents are loaded from the project root\'s "agents/" directory at build time. Verify the agent file is present in the project root being served.',
			},
		});
	});

	it('lets authored route middleware inspect a request when an exposed handler runs', async () => {
		let inspected = '';
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [
				agentRecord('assistant', {
					route: async (c, next) => {
						inspected = `${c.req.header('authorization')}:${new URL(c.req.url).pathname}`;
						await next();
						c.header('x-authored-middleware', 'ran');
					},
				}),
			],
			createAgentAdmission: (_agentName, _id) => async (payload) => ({
				submissionId: 'submission-1',
				result: { payload },
			}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(202);
		expect(response.headers.get('x-authored-middleware')).toBe('ran');
		expect(await response.json()).toEqual({
			streamUrl: 'http://localhost/api/agents/assistant/customer-123',
			offset: '-1',
			submissionId: 'submission-1',
		});
		expect(inspected).toBe('Bearer test-token:/api/agents/assistant/customer-123');
	});

	it('applies workflow middleware to run stream reads', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		const store = createTestEventStreamStore();
		await store.createStream('runs/run_01DAILYREPORT');
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs: async (c) => c.json({ blocked: true }, 401) })],
			runStore,
			eventStreamStore: store,

		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT'));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ blocked: true });
	});

	it('returns run_not_found for an unknown run without invoking runs middleware', async () => {
		const runs = vi.fn(async (_c, next) => next());
		configureFlueRuntime(nodeRuntime({
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs })],
			runStore: new InMemoryRunStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01MISSING'));

		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({ error: { type: 'run_not_found' } });
		expect(runs).not.toHaveBeenCalled();
	});

	it('returns run_not_found when the owning workflow does not expose runs', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		configureFlueRuntime(nodeRuntime({
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { route: async (_c, next) => next() })],
			runStore,
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT'));

		expect(response.status).toBe(404);
		expect((await response.json()) as unknown).toMatchObject({ error: { type: 'run_not_found' } });
	});

	it('authorizes a known run before returning method_not_allowed', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		const runs = vi.fn(async (_c, next) => next());
		configureFlueRuntime(nodeRuntime({
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs })],
			runStore,
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT', { method: 'DELETE' }));

		expect(response.status).toBe(405);
		expect(runs).toHaveBeenCalledOnce();
	});

	it('runs authorization before Cloudflare forwards run requests', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		const routeRunRequest = vi.fn(async () => new Response('forwarded'));
		configureFlueRuntime(cloudflareRuntime({
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs: async (c) => c.json({ blocked: true }, 401) })],
			createRunIndexForRequest: () => runStore,
			routeRunRequest,
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT'));

		expect(response.status).toBe(401);
		expect(routeRunRequest).not.toHaveBeenCalled();
	});

	it('serves the run record as plain JSON when GET /runs/:runId?meta is requested', async () => {
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
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs: async (_c, next) => next() })],
			runStore,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		// Stream params are ignored on the `?meta` view.
		const response = await app.fetch(
			new Request('http://localhost/api/runs/run_01DAILYREPORT?meta&offset=-1&live=long-poll'),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		// The run-record view carries no Durable Streams headers.
		expect(response.headers.get('stream-next-offset')).toBeNull();
		expect(response.headers.get('stream-up-to-date')).toBeNull();
		expect(response.headers.get('stream-closed')).toBeNull();
		expect(await response.json()).toEqual({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			status: 'completed',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: { report: 'weekly' },
			endedAt: '2026-06-01T10:05:00.000Z',
			isError: false,
			durationMs: 300_000,
			result: { delivered: true },
		});
	});

	it('applies workflow middleware to ?meta reads', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [workflowRecord('daily-report', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs: async (c) => c.json({ blocked: true }, 401) })],
			runStore,

		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/runs/run_01DAILYREPORT?meta'),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ blocked: true });
	});

	it('returns 404 for run reads when the recorded workflow is not in the current manifest', async () => {
		// A durable run pointer can outlive its workflow (rename/removal).
		// Stale runs must not be served without the middleware that guarded
		// them, so they are treated as not found.
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			input: {},
		});
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [workflowRecord('daily-report-v2', defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }), { runs: async (_c, next) => next() })],
			runStore,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const streamRead = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT'));
		expect(streamRead.status).toBe(404);
		expect(((await streamRead.json()) as { error: { type: string } }).error.type).toBe(
			'run_not_found',
		);

		const metaRead = await app.fetch(
			new Request('http://localhost/api/runs/run_01DAILYREPORT?meta'),
		);
		expect(metaRead.status).toBe(404);
		expect(((await metaRead.json()) as { error: { type: string } }).error.type).toBe(
			'run_not_found',
		);
	});

	it('returns an authored middleware response without invoking the handler when middleware short-circuits', async () => {
		const handlerCalls = 0;
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (c) => c.json({ blocked: true }, 401) })],
			createWorkflowContext: createTestContext,
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ blocked: true });
		expect(handlerCalls).toBe(0);
	});

	it('reports a diagnostic error when authored middleware neither returns a response nor awaits next()', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [
				agentRecord('assistant', { route: () => Promise.resolve(undefined) }),
			],
			createWorkflowContext: createTestContext,
		}));
		const app = new Hono();
		app.route('/api', flue());

		try {
			const response = await app.fetch(
				new Request('http://localhost/api/agents/assistant/customer-123', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'hello' }),
				}),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining(
					'Context is not finalized. Did you forget to return a Response object or await next()?',
				),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('returns unsupported_media_type when a request sends a body with a non-JSON content type', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, _id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'hello',
			}),
		);

		expect(response.status).toBe(415);
		expect(await response.json()).toEqual({
			error: {
				type: 'unsupported_media_type',
				message: 'Request body must be sent as application/json.',
				details:
					'Received Content-Type: "text/plain".\nSend the request body as JSON with the header "Content-Type: application/json", or omit the body entirely (and the Content-Type header) if the request doesn\'t have a payload.',
			},
		});
	});

	it('returns invalid_json when an application/json request body cannot be parsed', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, _id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{',
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				type: 'invalid_json',
				message: 'Request body is not valid JSON.',
				details: expect.stringMatching(
					/^The JSON parser reported: .+\nVerify the body is well-formed JSON, or omit the body entirely if the request doesn't have a payload\.$/,
				),
			},
		});
	});

	it('treats an empty workflow POST body as an empty object when a workflow is invoked', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [
				workflowRecord(
					'daily-report',
					defineWorkflow({
						agent: defineAgent(() => ({ model: false })),
						run: async () => undefined,
					}),
					{ route: async (_c, next) => next() },
				),
			],
			createWorkflowContext: createTestContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/daily-report?wait=result', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: unknown; runId: string };
		expect(body).toEqual({
			result: null,
			runId: expect.stringMatching(/^run_[0-9A-HJKMNP-TV-Z]{26}$/),
		});
	});

	it('rejects a direct agent body when it does not contain a string message', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, _id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 42 }),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details:
					'Direct agent requests must use JSON object body { "message": string, "images"?: image[] }.',
			},
		});
	});

	it('rejects a direct agent image above the encoded length limit', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, ) => async (payload) => ({ submissionId: 'submission-1', result: payload }),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					message: 'hello',
					images: [
						{
							type: 'image',
							data: 'a'.repeat(MAX_IMAGE_DATA_LENGTH + 1),
							mimeType: 'image/png',
						},
					],
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				type: 'invalid_request',
				details: `Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
			},
		});
	});

	it('temporarily exposes route-free agents and workflows without authored middleware', async () => {
		const seen: string[] = [];
		configureFlueRuntime(nodeRuntime({
			temporaryLocalExposure: true,
			agents: [agentRecord('assistant')],
			workflows: [
				workflowRecord(
					'internal-report',
					defineWorkflow({
						agent: defineAgent(() => ({ model: false })),
						run: async () => {
							seen.push('workflow');
							return 'done';
						},
					}),
				),
			],
			createAgentAdmission: (_agentName, id) => async () => ({
				submissionId: 'submission-1',
				result: { id },
			}),
			createWorkflowContext: createTestContext,
		}));
		const app = new Hono();
		app.use('/api/*', async (_c, next) => {
			seen.push('outer');
			await next();
		});
		app.route('/api', flue());

		const agentResponse = await app.fetch(
			new Request('http://localhost/api/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);
		const workflowResponse = await app.fetch(
			new Request('http://localhost/api/workflows/internal-report?wait=result', { method: 'POST' }),
		);

		expect(agentResponse.status).toBe(202);
		expect(workflowResponse.status).toBe(200);
		expect(await workflowResponse.json()).toMatchObject({ result: 'done' });
		expect(seen).toEqual(['outer', 'outer', 'workflow']);
	});

	it('renders a non-HTTP workflow as workflow_not_found when probed over HTTP', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			workflows: [
				workflowRecord(
					'internal-report',
					defineWorkflow({ agent: defineAgent(() => ({ model: false })), run: async () => undefined }),
				),
			],
		}));
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/internal-report', { method: 'POST' }),
		);

		expect(response.status).toBe(404);
		// Wire-identical to an unknown workflow so public callers cannot
		// enumerate internal-only workflow names by probing /workflows/<name>.
		expect(await response.json()).toEqual({
			error: {
				type: 'workflow_not_found',
				message: 'Workflow "internal-report" is not registered.',
				details: 'Verify the workflow name is correct.',
			},
		});
	});
});

describe('createDefaultFlueApp()', () => {
	it('mounts Flue routes at root when the generated runtime uses default application composition', async () => {
		configureFlueRuntime(nodeRuntime({
			target: 'node',
			agents: [agentRecord('assistant', { route: async (_c, next) => next() })],
			createAgentAdmission: (_agentName, id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			createWorkflowContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		}));
		const app = createDefaultFlueApp();

		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			streamUrl: 'http://localhost/agents/assistant/customer-123',
			offset: '-1',
			submissionId: 'submission-1',
		});
	});

	it('returns a canonical route envelope when the default application receives an unmatched path', async () => {
		configureFlueRuntime(nodeRuntime());
		const app = createDefaultFlueApp();

		const response = await app.fetch(new Request('http://localhost/not-a-route'));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				type: 'route_not_found',
				message: 'No route matches GET /not-a-route.',
				details: 'Verify the request method and path are correct.',
			},
		});
	});
});

describe('flue() agent attachments route', () => {
	it('returns 404 when the agent does not export an attachments middleware', async () => {
		configureFlueRuntime(nodeRuntime({ agents: [agentRecord('assistant')] }));
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1/attachments/att-1'),
		);

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('route_not_found');
	});

	it('includes opt-in guidance in the dev error envelope', async () => {
		configureFlueRuntime(nodeRuntime({ devMode: true, agents: [agentRecord('assistant')] }));
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1/attachments/att-1'),
		);

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { dev?: string } };
		expect(body.error.dev).toContain('attachments');
	});

	it('runs the exposed attachments middleware before serving', async () => {
		configureFlueRuntime(
			nodeRuntime({
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({ model: false })),
						attachments: async (c) => c.text('forbidden', 403),
					},
				],
			}),
		);
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1/attachments/att-1'),
		);

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('forbidden');
	});

	it('reaches the byte handler when the attachments middleware calls next', async () => {
		configureFlueRuntime(
			nodeRuntime({
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({ model: false })),
						attachments: async (_c, next) => {
							await next();
						},
					},
				],
			}),
		);
		const app = new Hono();
		app.route('/', flue());

		// No stream exists for this instance yet, so the handler is reached and
		// reports a missing stream — distinct from the not-exposed 404 above.
		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1/attachments/att-1'),
		);

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('stream_not_found');
	});
});

function createTestContext({ runId, request }: { runId: string; request: Request }) {
	return createFlueContext({
		id: runId,
		runId,
		env: {},
		req: request,
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
	});
}
