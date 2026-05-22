import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createDirectAgentHandler,
	createFlueContext,
	createRunSubscriberRegistry,
	InMemoryDispatchQueue,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	type AgentInitHandler,
} from '../src/internal.ts';
import type { FlueHarness, FlueSession } from '../src/types.ts';

describe('direct attached agent delivery', () => {
	it('routes direct HTTP through init and the default session without receive or dispatch', async () => {
		const initCalls: string[] = [];
		const prompts: Array<{ session: string; message: string }> = [];
		const receiveCalls: string[] = [];
		const dispatches: unknown[] = [];

		const init: AgentInitHandler = async ({ id }) => {
			initCalls.push(id);
			return fakeHarness(prompts);
		};

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			webhookAgents: ['assistant'],
			allowNonWebhook: false,
			handlers: { assistant: createDirectAgentHandler(init) },
			receiveHandlers: {
				assistant: async ({ delivery }) => receiveCalls.push(delivery.id),
			},
			dispatchQueue: new InMemoryDispatchQueue({
				process(input) {
					dispatches.push(input);
				},
			}),
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(res.status).toBe(200);
		expect((await res.json()) as unknown).toMatchObject({ result: { text: 'reply:hello' } });
		expect(initCalls).toEqual(['inst-1']);
		expect(prompts).toEqual([{ session: 'default', message: 'hello' }]);
		expect(receiveCalls).toEqual([]);
		expect(dispatches).toEqual([]);
	});

	it('routes direct HTTP to a supplied session', async () => {
		const prompts: Array<{ session: string; message: string }> = [];

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			webhookAgents: ['assistant'],
			allowNonWebhook: false,
			handlers: { assistant: createDirectAgentHandler(async () => fakeHarness(prompts)) },
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello', session: 'case:123' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(prompts).toEqual([{ session: 'case:123', message: 'hello' }]);
	});

	it('keeps external-channel agents directly addressable', async () => {
		const prompts: Array<{ session: string; message: string }> = [];

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, init: true }],
			},
			webhookAgents: ['moderator'],
			allowNonWebhook: false,
			handlers: { moderator: createDirectAgentHandler(async () => fakeHarness(prompts)) },
			receiveHandlers: {
				moderator: async () => {
					throw new Error('receive should not run for direct HTTP');
				},
			},
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/moderator/guild-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'check this' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(prompts).toEqual([{ session: 'default', message: 'check this' }]);
	});

	it('keeps SSE streaming behavior for direct HTTP callers', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			webhookAgents: ['assistant'],
			allowNonWebhook: false,
			handlers: { assistant: createDirectAgentHandler(async () => fakeHarness([])) },
			createContext: createTestContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const stream = await res.text();
		expect(stream).toContain('event: run_start');
		expect(stream).toContain('event: idle');
		expect(stream).toContain('event: run_end');
	});

	it('rejects non-provisional direct payload shapes clearly', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			webhookAgents: ['assistant'],
			allowNonWebhook: false,
			handlers: { assistant: createDirectAgentHandler(async () => fakeHarness([])) },
			createContext: createTestContext,
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: 'wrong' }),
			}),
		);

		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toMatchObject({ error: { type: 'invalid_request' } });
	});
});

function fakeHarness(prompts: Array<{ session: string; message: string }>): FlueHarness {
	return {
		name: 'default',
		session: async (name?: string) => fakeSession(name ?? 'default', prompts),
		sessions: {} as never,
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
	};
}

function fakeSession(session: string, prompts: Array<{ session: string; message: string }>): FlueSession {
	return {
		name: session,
		prompt: ((message: string) => {
			prompts.push({ session, message });
			return Promise.resolve({ text: `reply:${message}`, usage: {}, model: { id: 'test' } });
		}) as never,
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
		skill: (() => Promise.resolve({ text: '', usage: {}, model: { id: 'test' } })) as never,
		task: (() => Promise.resolve({ text: '', usage: {}, model: { id: 'test' } })) as never,
		compact: async () => {},
		delete: async () => {},
	};
}

function createTestContext(id: string, runId: string, payload: unknown, req: Request) {
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
