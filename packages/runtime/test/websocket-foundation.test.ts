import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	failRecoveredRun,
	InMemorySessionStore,
	invokeAttached,
	invokeDirectAttached,
	registeredAgentsForChannel,
	registeredWorkflowsForChannel,
	type FlueRuntime,
} from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';

describe('WebSocket transport foundation', () => {
	it('admits HTTP and WebSocket channels independently', () => {
		const runtime: FlueRuntime = {
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'http-only', channels: { http: true }, created: true },
					{ name: 'socket-only', channels: { websocket: true }, created: true },
					{ name: 'dual', channels: { http: true, websocket: true }, created: true },
				],
				workflows: [
					{ name: 'http-job', channels: { http: true } },
					{ name: 'socket-job', channels: { websocket: true } },
					{ name: 'dual-job', channels: { http: true, websocket: true } },
				],
			},
		};

		expect(registeredAgentsForChannel(runtime, 'http')).toEqual(['http-only', 'dual']);
		expect(registeredAgentsForChannel(runtime, 'websocket')).toEqual(['socket-only', 'dual']);
		expect(registeredWorkflowsForChannel(runtime, 'http')).toEqual(['http-job', 'dual-job']);
		expect(registeredWorkflowsForChannel(runtime, 'websocket')).toEqual(['socket-job', 'dual-job']);
	});

	it('preserves Node direct HTTP handler visibility without declaring WebSocket exposure', () => {
		const runtime: FlueRuntime = {
			target: 'node',
			handlers: { legacy: async () => null },
			manifest: {
				agents: [{ name: 'legacy', channels: {}, created: true }],
			},
		};

		expect(registeredAgentsForChannel(runtime, 'http')).toContain('legacy');
		expect(registeredAgentsForChannel(runtime, 'websocket')).not.toContain('legacy');
	});

	it('does not admit WebSocket-only workflows through HTTP POST', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'socket-job', channels: { websocket: true } }] },
			workflowHandlers: { 'socket-job': async () => ({ ok: true }) },
			createContext: createContext,
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/workflows/socket-job', { method: 'POST' }));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { type: 'workflow_not_http' } });
	});

	it('mounts configured channel applications lazily below a flue prefix', async () => {
		const mounted = new Hono();
		mounted.post('/events', async (c) => c.json({ path: new URL(c.req.url).pathname }));
		const app = new Hono();
		app.route('/api', flue());
		configureFlueRuntime({
			target: 'node',
			channelApps: { slack: mounted },
		});

		const response = await app.fetch(new Request('http://localhost/api/channels/slack/events', { method: 'POST' }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ path: '/events' });
	});

	it('forwards Cloudflare upgrades only for WebSocket-exposed targets and normalizes mounted paths', async () => {
		const forwarded: string[] = [];
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'assistant', channels: { websocket: true }, created: true },
					{ name: 'http-agent', channels: { http: true }, created: true },
				],
				workflows: [
					{ name: 'job', channels: { websocket: true } },
					{ name: 'http-job', channels: { http: true } },
				],
			},
			routeAgentRequest: async (request) => {
				forwarded.push(new URL(request.url).pathname);
				return Response.json({ ok: true });
			},
			routeWorkflowRequest: async (request, _env, target) => {
				forwarded.push(`${new URL(request.url).pathname}:${target.instanceId}`);
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/api', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/api/workflows/job', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/api/agents/http-agent/one', upgrade))).status).toBe(404);
		expect((await app.fetch(new Request('http://localhost/api/workflows/http-job', upgrade))).status).toBe(404);
		expect(forwarded[0]).toBe('/agents/assistant/one');
		expect(forwarded[1]).toMatch(/^\/workflows\/job:workflow:job:/);
	});

	it('runs exported Cloudflare resource middleware before HTTP and socket forwarding', async () => {
		const forwarded: string[] = [];
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: {
				agents: [{ name: 'assistant', channels: { http: true, websocket: true }, created: true }],
			},
			agentRouteMiddleware: {
				assistant: async (c, next) => {
					if (c.req.query('token') !== 'ok') return c.text('HTTP Unauthorized', 401);
					await next();
				},
			},
			agentWebSocketMiddleware: {
				assistant: async (c, next) => {
					if (c.req.query('token') !== 'ok') return c.text('Socket Unauthorized', 401);
					await next();
				},
			},
			routeAgentRequest: async (request) => {
				forwarded.push(`${request.method}:${new URL(request.url).pathname}`);
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/agents/assistant/one', { method: 'POST' }))).status).toBe(401);
		expect((await app.fetch(new Request('http://localhost/agents/assistant/one?token=ok', { method: 'POST' }))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/agents/assistant/one', upgrade))).status).toBe(401);
		expect((await app.fetch(new Request('http://localhost/agents/assistant/one?token=ok', upgrade))).status).toBe(200);
		expect(forwarded).toEqual(['POST:/agents/assistant/one', 'GET:/agents/assistant/one']);
	});

	it('does not execute an attached handler twice when exported middleware calls next twice', async () => {
		let forwarded = 0;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { http: true }, created: true }] },
			agentRouteMiddleware: {
				assistant: async (_c, next) => {
					await next();
					await next();
				},
			},
			routeAgentRequest: async () => {
				forwarded += 1;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', { method: 'POST' }));

		expect(response.status).toBe(500);
		expect(forwarded).toBe(1);
	});

	it('rejects exported route middleware that neither responds nor continues', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { http: true }, created: true }] },
			agentRouteMiddleware: { assistant: async () => undefined },
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', { method: 'POST' }));

		expect(response.status).toBe(500);
		expect(forwarded).toBe(false);
	});

	it('permits exported route middleware to short-circuit by assigning c.res', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { http: true }, created: true }] },
			agentRouteMiddleware: {
				assistant: async (c) => {
					c.res = c.text('Assigned Unauthorized', 401);
				},
			},
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', { method: 'POST' }));

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Assigned Unauthorized');
		expect(forwarded).toBe(false);
	});

	it('rejects exported socket middleware that neither responds nor continues', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { websocket: true }, created: true }] },
			agentWebSocketMiddleware: { assistant: async () => undefined },
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', upgrade));

		expect(response.status).toBe(500);
		expect(forwarded).toBe(false);
	});

	it('permits exported socket middleware to short-circuit by assigning c.res', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { websocket: true }, created: true }] },
			agentWebSocketMiddleware: {
				assistant: async (c) => {
					c.res = c.text('Assigned Socket Unauthorized', 401);
				},
			},
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', upgrade));

		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Assigned Socket Unauthorized');
		expect(forwarded).toBe(false);
	});

	it('runs Cloudflare custom app middleware before a mounted socket upgrade is forwarded', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { websocket: true }, created: true }] },
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.use('/api/agents/*', async (c, next) => {
			if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401);
			await next();
		});
		app.route('/api', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one', upgrade))).status).toBe(401);
		expect(forwarded).toBe(false);
		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one?token=ok', upgrade))).status).toBe(200);
		expect(forwarded).toBe(true);
	});

	it('rejects concurrent attached prompts to the same agent session', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = {
			agentName: 'assistant',
			id: 'user-1',
			payload: { message: 'hello', session: 'chat' },
			request: new Request('http://localhost/agents/assistant/user-1', { method: 'POST' }),
			createContext,
		};
		const first = invokeDirectAttached({
			...base,
			handler: async () => {
				await pending;
				return null;
			},
		});
		await expect(invokeDirectAttached({
			...base,
			handler: async () => null,
		})).rejects.toMatchObject({ details: 'This agent session already has an active prompt.' });
		release?.();
		await first;
	});

	it('rejects detached HTTP webhook mode for direct agent prompts', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [{ name: 'assistant', channels: { http: true }, created: true }] },
			handlers: { assistant: async () => null },
			createContext,
		});
		const app = new Hono();
		app.route('/', flue());
		const response = await app.fetch(new Request('http://localhost/agents/assistant/user-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-webhook': 'true' },
			body: JSON.stringify({ message: 'first', session: 'chat' }),
		}));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { type: 'invalid_request', details: 'Direct agent prompts are attached interactions. Use dispatch(...) for asynchronous delivery.' } });
	});

	it('persists an errored terminal run when recovery cannot continue', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'workflow' as const, workflowName: 'removed', instanceId: 'workflow:removed:one' };
		const runId = owner.instanceId;
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });

		await failRecoveredRun({
			label: 'removed',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/workflows/removed', { method: 'POST' }),
			createContext,
			error: new Error('Handler unavailable'),
			restartedAsRunId: 'workflow:removed:replacement',
			runStore,
			runRegistry,
		});

		const events = await runStore.getEvents(runId);
		expect(events.map((event) => event.type)).toEqual(['run_end']);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true, restartedAsRunId: 'workflow:removed:replacement' });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'errored' });
	});

	it('invokes attached work with an event sink independent of HTTP response formatting', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:test';
		const request = new Request('http://localhost/workflows/daily-report', {
			headers: { upgrade: 'websocket' },
		});

		const invocation = await invokeAttached({
			owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: runId },
			id: runId,
			runId,
			payload: { day: 'today' },
			restartedFromRunId: 'workflow:daily-report:previous',
			request,
			createContext,
			handler: async (ctx) => {
				expect(ctx.req).toBe(request);
				ctx.log.info('running');
				return { echoed: ctx.payload };
			},
			onEvent: (event) => {
				events.push(event);
			},
			emitIdleOnComplete: true,
			runStore,
			runRegistry,
		});

		expect(invocation).toEqual({ runId, result: { echoed: { day: 'today' } } });
		expect(events.map((event) => event.type)).toEqual(['run_start', 'log', 'idle', 'run_end']);
		expect(events.every((event) => event.runId === runId)).toBe(true);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', restartedFromRunId: 'workflow:daily-report:previous', result: { echoed: { day: 'today' } } });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});
});

function createContext(id: string, runId: string | undefined, payload: unknown, req: Request, initialEventIndex?: number) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		initialEventIndex,
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
