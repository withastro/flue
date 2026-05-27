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
	recoverWorkflowRun,
	invokeWorkflowAttached,
	invokeDirectAttached,
	registeredAgentsForTransport,
	registeredWorkflowsForTransport,
	type FlueRuntime,
} from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';

describe('WebSocket transport foundation', () => {
	it('admits HTTP and WebSocket transports independently', () => {
		const runtime: FlueRuntime = {
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'http-only', transports: { http: true }, created: true },
					{ name: 'socket-only', transports: { websocket: true }, created: true },
					{ name: 'dual', transports: { http: true, websocket: true }, created: true },
				],
				workflows: [
					{ name: 'http-job', transports: { http: true } },
					{ name: 'socket-job', transports: { websocket: true } },
					{ name: 'dual-job', transports: { http: true, websocket: true } },
				],
			},
		};

		expect(registeredAgentsForTransport(runtime, 'http')).toEqual(['http-only', 'dual']);
		expect(registeredAgentsForTransport(runtime, 'websocket')).toEqual(['socket-only', 'dual']);
		expect(registeredWorkflowsForTransport(runtime, 'http')).toEqual(['http-job', 'dual-job']);
		expect(registeredWorkflowsForTransport(runtime, 'websocket')).toEqual(['socket-job', 'dual-job']);
	});

	it('does not admit Node direct HTTP handlers without route exposure', () => {
		const runtime: FlueRuntime = {
			target: 'node',
			handlers: { internal: async () => null },
			manifest: {
				agents: [{ name: 'internal', transports: {}, created: true }],
			},
		};

		expect(registeredAgentsForTransport(runtime, 'http')).not.toContain('internal');
		expect(registeredAgentsForTransport(runtime, 'websocket')).not.toContain('internal');
	});

	it('does not admit WebSocket-only workflows through HTTP POST', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'socket-job', transports: { websocket: true } }] },
			workflowHandlers: { 'socket-job': async () => ({ ok: true }) },
			createContext: createContext,
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/workflows/socket-job', { method: 'POST' }));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { type: 'workflow_not_http' } });
	});

	it('forwards Cloudflare upgrades only for WebSocket-exposed targets and normalizes mounted paths', async () => {
		const forwarded: string[] = [];
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'assistant', transports: { websocket: true }, created: true },
					{ name: 'http-agent', transports: { http: true }, created: true },
				],
				workflows: [
					{ name: 'job', transports: { websocket: true } },
					{ name: 'http-job', transports: { http: true } },
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
				agents: [{ name: 'assistant', transports: { http: true, websocket: true }, created: true }],
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

	it('preserves Cloudflare agent JSON bodies after exported route middleware reads them', async () => {
		let verifiedBody = '';
		let forwardedBody = '';
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
			agentRouteMiddleware: {
				assistant: async (c, next) => {
					verifiedBody = await c.req.text();
					await next();
				},
			},
			routeAgentRequest: async (request) => {
				forwardedBody = await request.text();
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());
		const rawBody = JSON.stringify({ message: 'signed' });
		const response = await app.fetch(new Request('http://localhost/agents/assistant/one', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: rawBody,
		}));

		expect(response.status).toBe(200);
		expect(verifiedBody).toBe(rawBody);
		expect(forwardedBody).toBe(rawBody);
	});

	it('preserves Cloudflare workflow JSON bodies after exported route middleware reads them', async () => {
		let verifiedBody = '';
		let forwardedBody = '';
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [], workflows: [{ name: 'signed', transports: { http: true } }] },
			workflowRouteMiddleware: {
				signed: async (c, next) => {
					verifiedBody = await c.req.text();
					await next();
				},
			},
			routeWorkflowRequest: async (request) => {
				forwardedBody = await request.text();
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/', flue());
		const rawBody = JSON.stringify({ event: 'created' });
		const response = await app.fetch(new Request('http://localhost/workflows/signed', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: rawBody,
		}));

		expect(response.status).toBe(200);
		expect(verifiedBody).toBe(rawBody);
		expect(forwardedBody).toBe(rawBody);
	});

	it('does not execute an attached handler twice when exported middleware calls next twice', async () => {
		let forwarded = 0;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { websocket: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { websocket: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { websocket: true }, created: true }] },
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
			manifest: { agents: [{ name: 'assistant', transports: { http: true }, created: true }] },
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

	it('invokes workflow socket work through durable admission while preserving attached events', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:admitted';
		let admissions = 0;

		const invocation = await invokeWorkflowAttached({
			owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: runId },
			id: runId,
			runId,
			payload: { day: 'today' },
			request: new Request('http://localhost/workflows/daily-report', { headers: { upgrade: 'websocket' } }),
			createContext,
			startWorkflowAdmission: async (_runId, run) => { admissions++; return run(); },
			handler: async (ctx) => { ctx.log.info('running'); return { echoed: ctx.payload }; },
			onEvent: (event) => { events.push(event); },
			emitIdleOnComplete: true,
			runStore,
			runRegistry,
		});

		expect(admissions).toBe(1);
		expect(invocation).toEqual({ runId, result: { echoed: { day: 'today' } } });
		expect(events.map((event) => event.type)).toEqual(['run_start', 'log', 'idle', 'run_end']);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', result: { echoed: { day: 'today' } } });
	});

	it('emits a resume signal when durable terminalization continues an admitted workflow run', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runId = 'workflow:daily-report:terminal-recover';
		const owner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: runId };
		await runStore.createRun({ runId, owner, startedAt: '2026-05-27T00:00:00.000Z', payload: { day: 'today' } });
		await runStore.appendEvent(runId, { type: 'run_start', runId, owner, instanceId: runId, workflowName: 'daily-report', startedAt: '2026-05-27T00:00:00.000Z', payload: { day: 'today' } });

		await failRecoveredRun({
			label: 'daily-report',
			owner,
			id: runId,
			runId,
			payload: { day: 'today' },
			request: new Request('http://localhost/workflows/daily-report'),
			createContext: (id, currentRunId, payload, request, initialEventIndex) => {
				const ctx = createContext(id, currentRunId, payload, request, initialEventIndex);
				ctx.subscribeEvent((event) => { events.push(event); });
				return ctx;
			},
			error: new Error('interrupted'),
			runStore,
		});

		expect(events.map((event) => event.type)).toEqual(['run_resume', 'run_end']);
		expect(events[0]).toMatchObject({ type: 'run_resume', runId, workflowName: 'daily-report' });
	});

	it('emits a resume signal when durable recovery continues an admitted workflow run', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:recover';
		const owner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: runId };
		await runStore.createRun({ runId, owner, startedAt: '2026-05-27T00:00:00.000Z', payload: { day: 'today' } });
		await runStore.appendEvent(runId, { type: 'run_start', runId, owner, instanceId: runId, workflowName: 'daily-report', startedAt: '2026-05-27T00:00:00.000Z', payload: { day: 'today' } });

		const result = await recoverWorkflowRun({
			label: 'daily-report',
			owner,
			id: runId,
			runId,
			payload: { day: 'today' },
			request: new Request('http://localhost/workflows/daily-report'),
			createContext: (id, currentRunId, payload, request, initialEventIndex) => {
				const ctx = createContext(id, currentRunId, payload, request, initialEventIndex);
				ctx.subscribeEvent((event) => { events.push(event); });
				return ctx;
			},
			handler: async () => ({ ok: true }),
			runStore,
			runRegistry,
		});

		expect(result).toEqual({ result: { ok: true }, isError: false });
		expect(events.map((event) => event.type)).toEqual(['run_resume', 'run_end']);
		expect(events[0]).toMatchObject({ type: 'run_resume', runId, workflowName: 'daily-report', startedAt: '2026-05-27T00:00:00.000Z' });
	});

	it('preserves replacement linkage when a recovered workflow socket attempt is replaced', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const interruptedRunId = 'workflow:daily-report:socket-a';
		const replacementRunId = 'workflow:daily-report:socket-b';
		const interruptedOwner = { kind: 'workflow' as const, workflowName: 'daily-report', instanceId: interruptedRunId };
		await runStore.createRun({ runId: interruptedRunId, owner: interruptedOwner, startedAt: new Date().toISOString(), payload: { day: 'today' } });

		await failRecoveredRun({
			label: 'daily-report',
			owner: interruptedOwner,
			id: interruptedRunId,
			runId: interruptedRunId,
			payload: { day: 'today' },
			request: new Request('http://localhost/workflows/daily-report'),
			createContext,
			error: new Error('interrupted'),
			restartedAsRunId: replacementRunId,
			runStore,
			runRegistry,
		});
		await invokeWorkflowAttached({
			owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: replacementRunId },
			id: replacementRunId,
			runId: replacementRunId,
			payload: { day: 'today' },
			restartedFromRunId: interruptedRunId,
			request: new Request('http://localhost/workflows/daily-report'),
			createContext,
			startWorkflowAdmission: async (_runId, run) => run(),
			handler: async () => ({ ok: true }),
			runStore,
			runRegistry,
		});

		expect(await runStore.getRun(interruptedRunId)).toMatchObject({ status: 'errored', restartedAsRunId: replacementRunId });
		expect(await runStore.getRun(replacementRunId)).toMatchObject({ status: 'completed', restartedFromRunId: interruptedRunId });
	});

	it('invokes attached work with an event sink independent of HTTP response formatting', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:test';
		const request = new Request('http://localhost/workflows/daily-report', {
			headers: { upgrade: 'websocket' },
		});

		const invocation = await invokeWorkflowAttached({
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
		expect(events[0]).toMatchObject({ type: 'run_start', restartedFromRunId: 'workflow:daily-report:previous' });
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
