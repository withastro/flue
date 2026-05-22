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
import type { FlueHarness, FlueSession, SessionData, SessionEnv, SessionStore } from '../src/types.ts';

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

	it('rejects dynamic behavior options passed to spawn', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			handlers: {
				assistant: createDirectAgentHandler(({ spawn }) =>
					spawn({ inherit: {}, instructions: 'dynamic' } as never),
				),
			},
			createContext: createTestContext,
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

		expect(res.status).toBe(500);
		expect((await res.json()) as unknown).toMatchObject({
			error: { type: 'internal_error' },
		});
	});

	it('passes the target instance id into spawn sandbox factories', async () => {
		const sandboxCalls: Array<{ id: string; cwd?: string }> = [];
		const prompts: Array<{ session: string; message: string }> = [];
		const store = new RecordingSessionStore();

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, init: true }],
			},
			handlers: {
				assistant: createDirectAgentHandler(({ spawn }) =>
					spawn({
						inherit: { model: false },
						cwd: '/workspace',
						persist: store,
						sandbox: {
							async createSessionEnv(options) {
								sandboxCalls.push(options);
								return fakeEnv();
							},
						},
					}),
				),
			},
			createContext: createTestContext,
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

		expect(res.status).toBe(500);
		expect(sandboxCalls).toEqual([{ id: 'inst-1', cwd: '/workspace' }]);
		expect(store.loadCalls).toContain('agent-session:["inst-1","default","default"]');
		expect(prompts).toEqual([]);
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

function fakeEnv(): SessionEnv {
	return {
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		cwd: '/',
		resolvePath: (path) => path,
	};
}

class RecordingSessionStore implements SessionStore {
	readonly loadCalls: string[] = [];
	async save(_id: string, _data: SessionData): Promise<void> {}
	async load(id: string): Promise<SessionData | null> {
		this.loadCalls.push(id);
		return null;
	}
	async delete(_id: string): Promise<void> {}
}
