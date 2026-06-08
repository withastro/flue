import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
} from '../src/internal.ts';
import { createNodeWebSocketTransport, type NodeWebSocketTransport } from '../src/node/index.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
	const results = await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
	const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
	if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean up test sockets.');
});

describe('createNodeWebSocketTransport()', () => {
	it('sends an agent ready frame when an exposed agent socket opens', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
				workflows: [],
			},
			agentHandlers: { assistant: async (ctx) => ctx.payload },
			workflowHandlers: {},
			createAdmission: { assistant: () => async () => null },
			createContext,
		});
		const { messages } = await openTestSocket(transport, 'agent');

		expect(await waitForMessage(messages, (message) => message.type === 'ready')).toEqual({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'instance-1',
		});
	});

	it('sends a workflow ready frame when an exposed workflow socket opens', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [],
				workflows: [{ name: 'job', transports: { websocket: true } }],
			},
			agentHandlers: {},
			workflowHandlers: { job: async (ctx) => ctx.payload },
			createAdmission: {},
			createContext,
		});
		const { messages } = await openTestSocket(transport, 'workflow');

		expect(await waitForMessage(messages, (message) => message.type === 'ready')).toEqual({
			version: 1,
			type: 'ready',
			target: 'workflow',
			name: 'job',
		});
	});

	it('replies with pong when an agent socket receives ping', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
				workflows: [],
			},
			agentHandlers: { assistant: async (ctx) => ctx.payload },
			workflowHandlers: {},
			createAdmission: { assistant: () => async () => null },
			createContext,
		});
		const { socket, messages } = await openTestSocket(transport, 'agent');
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(JSON.stringify({ version: 1, type: 'ping', requestId: 'ping-1' }));

		expect(await waitForMessage(messages, (message) => message.type === 'pong')).toEqual({
			version: 1,
			type: 'pong',
			requestId: 'ping-1',
		});
	});

	// Agent prompt streaming/result/sequential/error-recovery tests were removed
	// because they tested the inline (non-durable) handler path that no longer
	// exists. Agent prompt behavior through the durable submission lifecycle is
	// covered by the NodeAgentCoordinator test suite.

	it('streams started event and result frames before closing when a workflow socket receives an invocation', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [],
				workflows: [{ name: 'job', transports: { websocket: true } }],
			},
			agentHandlers: {},
			workflowHandlers: {
				job: async (ctx) => {
					ctx.emitEvent({ type: 'log', level: 'info', message: 'working' });
					return ctx.payload;
				},
			},
			createAdmission: {},
			createContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
		});
		const { socket, messages } = await openTestSocket(transport, 'workflow');
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'workflow-1',
				payload: { topic: 'support' },
			}),
		);
		const started = await waitForMessage(
			messages,
			(message) => message.type === 'started' && message.requestId === 'workflow-1',
		);
		if (!('runId' in started) || typeof started.runId !== 'string')
			throw new Error('Expected workflow run id.');
		await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'workflow-1',
		);

		expect(messages).toMatchObject([
			{ version: 1, type: 'ready', target: 'workflow', name: 'job' },
			{ version: 1, type: 'started', requestId: 'workflow-1', runId: started.runId },
			{
				version: 1,
				type: 'event',
				requestId: 'workflow-1',
				runId: started.runId,
				event: { type: 'run_start', runId: started.runId, payload: { topic: 'support' } },
			},
			{
				version: 1,
				type: 'event',
				requestId: 'workflow-1',
				runId: started.runId,
				event: { type: 'log', level: 'info', message: 'working' },
			},
			{
				version: 1,
				type: 'event',
				requestId: 'workflow-1',
				runId: started.runId,
				event: { type: 'idle' },
			},
			{
				version: 1,
				type: 'event',
				requestId: 'workflow-1',
				runId: started.runId,
				event: {
					type: 'run_end',
					runId: started.runId,
					result: { topic: 'support' },
					isError: false,
				},
			},
			{
				version: 1,
				type: 'result',
				requestId: 'workflow-1',
				runId: started.runId,
				result: { topic: 'support' },
			},
		]);
		expect(await closed).toEqual({ code: 1000, reason: 'Workflow completed' });
	});

	it('sends a caller-safe workflow error without starting or executing when workflow admission rejects', async () => {
		let executions = 0;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const transport = createNodeWebSocketTransport({
				manifest: {
					agents: [],
					workflows: [{ name: 'job', transports: { websocket: true } }],
				},
				agentHandlers: {},
				workflowHandlers: {
					job: async () => {
						executions++;
						return null;
					},
				},
				createAdmission: {},
				createContext,
				startWorkflowAdmission: async () => {
					throw new Error('private admission failure');
				},
				runStore: new InMemoryRunStore(),
			});
			const { socket, messages } = await openTestSocket(transport, 'workflow');
			await waitForMessage(messages, (message) => message.type === 'ready');
			const closed = waitForClose(socket);

			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'workflow-failed' }));

			expect(
				await waitForMessage(
					messages,
					(message) => message.type === 'error' && message.requestId === 'workflow-failed',
				),
			).toEqual({
				version: 1,
				type: 'error',
				requestId: 'workflow-failed',
				runId: expect.any(String),
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(messages).not.toContainEqual(
				expect.objectContaining({ type: 'started', requestId: 'workflow-failed' }),
			);
			expect(executions).toBe(0);
			expect(await closed).toEqual({ code: 1011, reason: 'Workflow failed' });
		} finally {
			consoleError.mockRestore();
		}
	});

	it('sends a caller-safe workflow error without starting or executing when run creation rejects', async () => {
		let executions = 0;
		const runStore = new InMemoryRunStore();
		vi.spyOn(runStore, 'createRun').mockRejectedValue(new Error('private run store failure'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const transport = createNodeWebSocketTransport({
				manifest: {
					agents: [],
					workflows: [{ name: 'job', transports: { websocket: true } }],
				},
				agentHandlers: {},
				workflowHandlers: {
					job: async () => {
						executions++;
						return null;
					},
				},
				createAdmission: {},
				createContext,
				runStore,
			});
			const { socket, messages } = await openTestSocket(transport, 'workflow');
			await waitForMessage(messages, (message) => message.type === 'ready');
			const closed = waitForClose(socket);

			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'workflow-failed' }));

			expect(
				await waitForMessage(
					messages,
					(message) => message.type === 'error' && message.requestId === 'workflow-failed',
				),
			).toEqual({
				version: 1,
				type: 'error',
				requestId: 'workflow-failed',
				runId: expect.any(String),
				error: {
					type: 'internal_error',
					message: 'An internal error occurred.',
					details: 'The server encountered an unexpected error while handling this request.',
				},
			});
			expect(messages).not.toContainEqual(
				expect.objectContaining({ type: 'started', requestId: 'workflow-failed' }),
			);
			expect(executions).toBe(0);
			expect(await closed).toEqual({ code: 1011, reason: 'Workflow failed' });
		} finally {
			consoleError.mockRestore();
		}
	});

	it('rejects a second workflow invocation when a workflow socket has already been invoked', async () => {
		let executions = 0;
		let release: (() => void) | undefined;
		const runStore = new InMemoryRunStore();
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [],
				workflows: [{ name: 'job', transports: { websocket: true } }],
			},
			agentHandlers: {},
			workflowHandlers: {
				job: async () => {
					executions++;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return null;
				},
			},
			createAdmission: {},
			createContext,
			runStore,
			runRegistry: new InMemoryRunRegistry(),
		});
		const { socket, messages } = await openTestSocket(transport, 'workflow');
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'workflow-1' }));
		const started = await waitForMessage(
			messages,
			(message) => message.type === 'started' && message.requestId === 'workflow-1',
		);
		if (!('runId' in started) || typeof started.runId !== 'string')
			throw new Error('Expected workflow run id.');
		const closed = waitForClose(socket);
		socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'workflow-2' }));

		try {
			expect(
				await waitForMessage(
					messages,
					(message) => message.type === 'error' && message.requestId === 'workflow-2',
				),
			).toEqual({
				version: 1,
				type: 'error',
				requestId: 'workflow-2',
				error: {
					type: 'invalid_request',
					message: 'Request is malformed.',
					details: 'Workflow WebSocket connections accept one invocation only.',
				},
			});
			expect(executions).toBe(1);
			expect(await closed).toEqual({ code: 1008, reason: 'Workflow accepts one invocation only' });
		} finally {
			release?.();
			await waitFor(async () => (await runStore.getRun(started.runId))?.status === 'completed');
		}
	});

	it('rejects binary messages when an agent socket receives non-text input', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
				workflows: [],
			},
			agentHandlers: { assistant: async (ctx) => ctx.payload },
			workflowHandlers: {},
			createAdmission: { assistant: () => async () => null },
			createContext,
		});
		const { socket, messages } = await openTestSocket(transport, 'agent');
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(Buffer.from('agent binary'));

		expect(await waitForMessage(messages, (message) => message.type === 'error')).toEqual({
			version: 1,
			type: 'error',
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details: 'Binary WebSocket messages are not supported.',
			},
		});
		expect(await closed).toEqual({ code: 1003, reason: 'Binary messages are not supported' });
	});

	it('rejects binary messages when a workflow socket receives non-text input', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [],
				workflows: [{ name: 'job', transports: { websocket: true } }],
			},
			agentHandlers: {},
			workflowHandlers: { job: async (ctx) => ctx.payload },
			createAdmission: {},
			createContext,
		});
		const { socket, messages } = await openTestSocket(transport, 'workflow');
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(Buffer.from('workflow binary'));

		expect(await waitForMessage(messages, (message) => message.type === 'error')).toEqual({
			version: 1,
			type: 'error',
			error: {
				type: 'invalid_request',
				message: 'Request is malformed.',
				details: 'Binary WebSocket messages are not supported.',
			},
		});
		expect(await closed).toEqual({
			code: 1003,
			reason: 'Binary messages are not supported',
		});
	});

	it('terminates the client socket and drains server clients when the server-side socket emits an error', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
				workflows: [],
			},
			agentHandlers: { assistant: async (ctx) => ctx.payload },
			workflowHandlers: {},
			createAdmission: { assistant: () => async () => null },
			createContext,
		});
		const { socket, messages } = await openTestSocket(transport, 'agent');
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);
		const [serverSocket] = transport.server.clients;
		if (!serverSocket) throw new Error('Expected connected server-side WebSocket.');

		serverSocket.emit('error', new Error('server-side socket failure'));

		expect(await closed).toEqual({ code: 1006, reason: '' });
		await waitFor(() => transport.server.clients.size === 0);
	});

	it('sends close frames when the transport is closed', async () => {
		const transport = createNodeWebSocketTransport({
			manifest: {
				agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
				workflows: [],
			},
			agentHandlers: { assistant: async (ctx) => ctx.payload },
			workflowHandlers: {},
			createAdmission: { assistant: () => async () => null },
			createContext,
		});
		const { socket, messages } = await openTestSocket(transport, 'agent');
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		await transport.close();

		expect(await closed).toEqual({ code: 1001, reason: 'Server shutting down' });
		expect(transport.server.clients.size).toBe(0);
	});
});

interface TestSocket {
	socket: WebSocket;
	messages: WebSocketServerMessage[];
}

async function openTestSocket(
	transport: NodeWebSocketTransport,
	target: 'agent' | 'workflow',
): Promise<TestSocket> {
	let server: ReturnType<typeof serve> | undefined;
	let socket: WebSocket | undefined;
	closeCallbacks.push(async () => {
		const results = await Promise.allSettled([
			closeSocket(socket),
			transport.close(),
			closeServer(server),
		]);
		const errors = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		);
		if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean up test socket.');
	});

	const app = new Hono();
	const path = target === 'agent' ? '/agents/:name/:id' : '/workflows/:name';
	app.get(path, target === 'agent' ? transport.agentRoute : transport.workflowRoute);
	server = serve({ fetch: app.fetch, websocket: { server: transport.server }, port: 0 });
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected test server address.');
	const route = target === 'agent' ? '/agents/assistant/instance-1' : '/workflows/job';
	socket = new WebSocket(`ws://localhost:${address.port}${route}`);
	const messages = collectMessages(socket);
	await new Promise<void>((resolve, reject) => {
		socket?.addEventListener('open', () => resolve(), { once: true });
		socket?.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), {
			once: true,
		});
	});
	return { socket, messages };
}

async function closeSocket(socket: WebSocket | undefined): Promise<void> {
	if (!socket || socket.readyState === WebSocket.CLOSED) return;
	if (socket.readyState === WebSocket.CONNECTING) {
		socket.terminate();
		return;
	}
	await new Promise<void>((resolve) => {
		socket.addEventListener('close', () => resolve(), { once: true });
		if (socket.readyState === WebSocket.OPEN) socket.close();
	});
}

async function closeServer(server: ReturnType<typeof serve> | undefined): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function createContext(id: string, runId: string | undefined, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		req,
		env: {},
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}

function collectMessages(socket: WebSocket): WebSocketServerMessage[] {
	const messages: WebSocketServerMessage[] = [];
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as WebSocketServerMessage);
	});
	return messages;
}

async function waitForMessage(
	messages: WebSocketServerMessage[],
	predicate: (message: WebSocketServerMessage) => boolean,
): Promise<WebSocketServerMessage> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const message = messages.find(predicate);
		if (message) return message;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Expected condition was not met.');
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		socket.addEventListener(
			'close',
			(event) => resolve({ code: event.code, reason: event.reason }),
			{ once: true },
		);
	});
}
