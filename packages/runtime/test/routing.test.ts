import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFlueContext } from '../src/client.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { configureFlueRuntime, createDefaultFlueApp, flue, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { InMemorySessionStore } from '../src/session.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('flue()', () => {
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
			paths: Record<string, Record<string, unknown>>;
		};
		expect(body.info).toMatchObject({ title: 'Flue Public API', version: '9.9.9' });
		expect(Object.keys(body.paths)).toHaveLength(2);
		expect(body.paths).toMatchObject({
			'/workflows/{name}': { post: expect.any(Object) },
			'/agents/{name}/{id}': { post: expect.any(Object) },
		});
		expect(Object.keys(body.paths['/workflows/{name}'] ?? {})).toEqual(['post']);
		expect(Object.keys(body.paths['/agents/{name}/{id}'] ?? {})).toEqual(['post']);
	});

	it('invokes an HTTP-exposed agent when the mounted app receives a valid agent POST', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (id) => async (payload) => ({ instanceId: id, payload }),
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

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			result: { instanceId: 'customer-123', payload: { message: 'hello' } },
		});
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
				assistant: (_id) => async (payload) => ({ payload }),
			},
			agentRouteMiddleware: {
				assistant: async (c, next) => {
					inspected = `${c.req.header('authorization')}:${new URL(c.req.url).pathname}`;
					await next();
					c.header('x-authored-middleware', 'ran');
				},
			},
			createContext: createTestContext,
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

		expect(response.status).toBe(200);
		expect(response.headers.get('x-authored-middleware')).toBe('ran');
		expect(await response.json()).toEqual({ result: { payload: { message: 'hello' } } });
		expect(inspected).toBe('Bearer test-token:/api/agents/assistant/customer-123');
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
				assistant: (_id) => async (payload) => ({ message: payload.message }),
			},
			createContext: createTestContext,
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
				assistant: (_id) => async (payload) => ({ message: payload.message }),
			},
			createContext: createTestContext,
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
		});
		const app = new Hono();
		app.route('/api', flue());

		const response = await app.fetch(
			new Request('http://localhost/api/workflows/daily-report?wait=result', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: unknown; _meta: { runId: string } };
		expect(body).toEqual({
			result: { payload: {} },
			_meta: { runId: expect.stringMatching(/^workflow:daily-report:/) },
		});
		expect(response.headers.get('x-flue-run-id')).toBe(body._meta.runId);
	});

	it('rejects a direct agent body when it does not contain a string message', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', transports: { http: true }, created: true }],
			},
			createAdmission: {
				assistant: (_id) => async (payload) => ({ message: payload.message }),
			},
			createContext: createTestContext,
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
					'Direct agent requests must use JSON object body { "message": string }.',
			},
		});
	});

	it('rejects an HTTP workflow when the workflow is built but not exposed over HTTP', async () => {
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
		expect(await response.json()).toEqual({
			error: {
				type: 'workflow_not_http',
				message: 'Workflow "internal-report" is not web-accessible.',
				details: 'This endpoint is not exposed over HTTP.',
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
				assistant: (id) => async (payload) => ({ instanceId: id, payload }),
			},
			createContext: createTestContext,
		});
		const app = createDefaultFlueApp();

		const response = await app.fetch(
			new Request('http://localhost/agents/assistant/customer-123', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			result: { instanceId: 'customer-123', payload: { message: 'hello' } },
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
				details: 'Agents are served at POST /agents/<name>/<id>.',
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
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
