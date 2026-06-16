import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFlueContext } from '../src/client.ts';
import { ModelNotConfiguredError } from '../src/errors.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { MAX_IMAGE_DATA_LENGTH } from '../src/persisted-images.ts';
import { agentStreamPath } from '../src/runtime/event-stream-store.ts';
import {
	configureFlueRuntime,
	createDefaultFlueApp,
	flue,
	resetFlueRuntimeForTests,
} from '../src/runtime/flue-app.ts';
import { InMemorySessionStore } from '../src/session.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('flue()', () => {
	it('serves a discovered channel handler beneath the flue mount prefix', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				slack: {
					'POST /events': async (c) =>
						c.json({
							path: c.req.path,
							team: c.req.query('team'),
						}),
				},
			},
		});
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

		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				slack: {
					'POST /events': async () => response,
				},
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const result = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'POST' }),
		);

		expect(result.status).toBe(202);
		expect(await result.text()).toBe('accepted');
	});

	it('rejects a tagged object when a channel handler does not return a Fetch response', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				slack: {
					'POST /events': async () => ({ [Symbol.toStringTag]: 'Response' }) as unknown as Response,
				},
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				intercom: {
					'HEAD /webhook': handler,
				},
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				slack: {
					'POST /events': async (c) => c.body(null, 200),
					'PUT /events': async (c) => c.body(null, 202),
				},
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'GET' }),
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST, PUT');
	});

	it('serves channel route suffixes with multiple path segments', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				custom: {
					'POST /webhooks/retries': async (c) => c.text(c.req.param('suffix') ?? ''),
				},
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(
			new Request('http://localhost/channels/custom/webhooks/retries', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('webhooks/retries');
	});

	it('does not serve the top-level channel namespace or an unknown suffix', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [] },
			channelHandlers: {
				slack: {
					'POST /events': async (c) => c.body(null, 200),
				},
			},
		});
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

	it('describes public agent workflow and workflow-run routes when the mounted app serves openapi.json', async () => {
		configureFlueRuntime({
			target: 'node',
			runtimeVersion: '9.9.9',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
				workflows: [{ name: 'daily-report', transports: { http: true } }],
			},
		});
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/openapi.json'));

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			info: { title: string; version: string };
			paths: Record<string, Record<string, any>>;
		};
		expect(body.info).toMatchObject({ title: 'Flue Public API', version: '9.9.9' });
		expect(Object.keys(body.paths)).toHaveLength(2);
		expect(body.paths).toMatchObject({
			'/workflows/{name}': { post: expect.any(Object) },
			'/agents/{name}/{id}': { post: expect.any(Object) },
		});
		expect(Object.keys(body.paths['/workflows/{name}'] ?? {})).toEqual(['post']);
		expect(Object.keys(body.paths['/agents/{name}/{id}'] ?? {})).toEqual(['post']);
		// Both invocation routes document the same modes: 202 admission by
		// default plus the ?wait=result synchronous mode.
		for (const post of [
			body.paths['/workflows/{name}']?.post,
			body.paths['/agents/{name}/{id}']?.post,
		]) {
			expect(post['x-flue-invocation-modes']).toEqual(['accepted', 'wait-result']);
			expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['200', '202']));
			expect(post.parameters).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: 'wait', in: 'query' })]),
			);
		}
		const schema =
			body.paths['/agents/{name}/{id}']?.post?.requestBody?.content?.['application/json']?.schema;
		expect(schema).toMatchObject({
			type: 'object',
			required: ['message'],
			properties: {
				message: { type: 'string' },
				images: {
					type: 'array',
					items: {
						type: 'object',
						required: ['type', 'data', 'mimeType'],
						properties: {
							type: { const: 'image' },
							data: { type: 'string', maxLength: MAX_IMAGE_DATA_LENGTH },
							mimeType: { type: 'string' },
						},
					},
				},
			},
		});
	});

	it('invokes an HTTP-exposed agent when the mounted app receives a valid agent POST', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
			createAdmission: {
				assistant: () => async (payload) => ({ submissionId: 'submission-1', result: payload }),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				// Simulates the session surface failing the prompt (e.g. no model
				// configured) — the typed envelope must reach the caller instead
				// of an opaque internal_error.
				assistant: () => async () => {
					throw new ModelNotConfiguredError({ callSite: 'this prompt() call' });
				},
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [],
				workflows: [{ name: 'daily-report', transports: { http: true } }],
			},
			workflowHandlers: { 'daily-report': () => ({ delivered: true }) },
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore: createTestEventStreamStore(),
		});
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

	it("captures the prompt tail offset and serves exactly that prompt's events from it", async () => {
		const store = createTestEventStreamStore();
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				// Simulates the coordinator: each accepted prompt creates the
				// stream (idempotent) and appends one event to it.
				assistant: (id) => async (payload) => {
					await store.createStream(agentStreamPath('assistant', id));
					await store.appendEvent(agentStreamPath('assistant', id), {
						type: 'message',
						text: (payload as { message: string }).message,
					});
					return { submissionId: `submission-${(payload as { message: string }).message}` };
				},
			},
			createContext: createTestContext,
			eventStreamStore: store,
		});
		const app = new Hono();
		app.route('/api', flue());

		const prompt = (message: string) =>
			app.fetch(
				new Request('http://localhost/api/agents/assistant/customer-123', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message }),
				}),
			);

		// First prompt on a fresh instance: the captured tail is the start sentinel.
		const first = await prompt('hello');
		expect(first.status).toBe(202);
		const firstBody = (await first.json()) as { streamUrl: string; offset: string };
		expect(firstBody.offset).toBe('-1');

		// The accepted streamUrl is immediately readable — not a blank 404.
		const fullRead = await app.fetch(new Request(firstBody.streamUrl));
		expect(fullRead.status).toBe(200);
		expect(await fullRead.json()).toEqual([{ type: 'message', text: 'hello' }]);

		// Second prompt: the captured offset is the real stream tail before
		// this prompt's first event, not a degenerate constant.
		const second = await prompt('again');
		expect(second.status).toBe(202);
		const secondBody = (await second.json()) as { streamUrl: string; offset: string };
		expect(secondBody.offset).toMatch(/^\d{16}_\d{16}$/);

		// Reading from that offset returns exactly the second prompt's events.
		const offsetRead = await app.fetch(
			new Request(`${secondBody.streamUrl}?offset=${secondBody.offset}`),
		);
		expect(offsetRead.status).toBe(200);
		expect(await offsetRead.json()).toEqual([{ type: 'message', text: 'again' }]);
	});

	it("keeps the agent stream unreadable when the instance's only prompt fails admission", async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				// Simulates the coordinator rejecting admission (e.g. shutting down).
				assistant: () => async () => {
					throw new Error('[flue] runtime is shutting down; new submissions are not accepted.');
				},
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [],
				workflows: [{ name: 'daily-report', transports: { http: true } }],
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			devMode: false,
			manifest: {
				agents: [{ name: 'private-support', transports: { http: true }, created: true }],
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			devMode: true,
			manifest: {
				agents: [{ name: 'private-support', transports: { http: true }, created: true }],
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (_id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { payload },
				}),
			},
			agentRouteMiddleware: {
				assistant: async (c, next) => {
					inspected = `${c.req.header('authorization')}:${new URL(c.req.url).pathname}`;
					await next();
					c.header('x-authored-middleware', 'ran');
				},
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
			payload: {},
		});
		const store = createTestEventStreamStore();
		await store.createStream('runs/run_01DAILYREPORT');
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			runStore,
			eventStreamStore: store,
			workflowRouteMiddleware: {
				'daily-report': async (c) => c.json({ blocked: true }, 401),
			},
		});
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(new Request('http://localhost/api/runs/run_01DAILYREPORT'));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ blocked: true });
	});

	it('serves the run record as plain JSON when GET /runs/:runId?meta is requested', async () => {
		const runStore = new InMemoryRunStore();
		await runStore.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-01T10:00:00.000Z',
			payload: { report: 'weekly' },
		});
		await runStore.endRun({
			runId: 'run_01DAILYREPORT',
			endedAt: '2026-06-01T10:05:00.000Z',
			durationMs: 300_000,
			isError: false,
			result: { delivered: true },
		});
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			runStore,
			eventStreamStore: createTestEventStreamStore(),
		});
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
			payload: { report: 'weekly' },
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
			payload: {},
		});
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'daily-report', transports: { http: true } }] },
			runStore,
			workflowRouteMiddleware: {
				'daily-report': async (c) => c.json({ blocked: true }, 401),
			},
		});
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
			payload: {},
		});
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [],
				workflows: [{ name: 'daily-report-v2', transports: { http: true } }],
			},
			runStore,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			agentRouteMiddleware: {
				assistant: async (c) => c.json({ blocked: true }, 401),
			},
			createContext: createTestContext,
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			agentRouteMiddleware: { assistant: () => Promise.resolve(undefined) },
			createContext: createTestContext,
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (_id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (_id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [],
				workflows: [{ name: 'daily-report', transports: { http: true } }],
			},
			workflowHandlers: { 'daily-report': (ctx) => ({ payload: ctx.payload }) },
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			eventStreamStore: createTestEventStreamStore(),
		});
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/daily-report?wait=result', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: unknown; runId: string; streamUrl: string };
		expect(body).toEqual({
			result: { payload: {} },
			runId: expect.stringMatching(/^run_[0-9A-HJKMNP-TV-Z]{26}$/),
			streamUrl: expect.any(String),
			offset: '-1',
		});
		expect(body.streamUrl).toBe(`http://localhost/api/runs/${body.runId}`);
	});

	it('rejects a direct agent body when it does not contain a string message', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (_id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { message: payload.message },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: () => async (payload) => ({ submissionId: 'submission-1', result: payload }),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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

	it('renders a non-HTTP workflow as workflow_not_found when probed over HTTP', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [],
				workflows: [{ name: 'internal-report', transports: {} }],
			},
		});
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
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (id) => async (payload) => ({
					submissionId: 'submission-1',
					result: { instanceId: id, payload },
				}),
			},
			createContext: createTestContext,
			eventStreamStore: createTestEventStreamStore(),
		});
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
		configureFlueRuntime({ target: 'node', manifest: { agents: [] } });
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

function createTestContext(id: string, runId: string | undefined, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
