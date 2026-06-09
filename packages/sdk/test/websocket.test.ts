import { describe, expect, it } from 'vitest';
import {
	type AgentSocketPromptOptions,
	createFlueClient,
	FlueSocketError,
	type LlmAssistantMessage,
	type LlmMessage,
	type WebSocketLike,
} from '../src/index.ts';

class FakeSocket implements WebSocketLike {
	readonly sent: string[] = [];
	readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

	addEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closeCalls.push({ code, reason });
	}

	message(value: unknown): void {
		this.emit('message', { data: JSON.stringify(value) });
	}

	malformed(value: string): void {
		this.emit('message', { data: value });
	}

	closed(): void {
		this.emit('close', {});
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function socketClient(
	options: Parameters<typeof createFlueClient>[0] = { baseUrl: 'https://flue.test/api/' },
) {
	const sockets: Array<{ url: string; socket: FakeSocket }> = [];
	const client = createFlueClient({
		...options,
		websocket: (url) => {
			const socket = new FakeSocket();
			sockets.push({ url, socket });
			return socket;
		},
	});
	return { client, sockets };
}

describe('WebSocket clients', () => {
	it('builds custom-mounted socket URLs and transforms authenticated handshakes for both targets', () => {
		const targets: unknown[] = [];
		const { client, sockets } = socketClient({
			baseUrl: 'https://flue.test/api/',
			token: 'http-only-token',
			headers: { authorization: 'Bearer http-only-header' },
			websocketUrl: (url, target) => {
				targets.push(target);
				url.searchParams.set('token', 'socket-token');
				return url;
			},
		});

		client.agents.connect('assistant bot', 'customer/123');
		client.workflows.connect('triage');

		expect(sockets.map(({ url }) => url)).toEqual([
			'wss://flue.test/api/agents/assistant%20bot/customer%2F123?token=socket-token',
			'wss://flue.test/api/workflows/triage?token=socket-token',
		]);
		expect(targets).toEqual([
			{ target: 'agent', name: 'assistant bot', instanceId: 'customer/123' },
			{ target: 'workflow', name: 'triage' },
		]);
	});

	it('connects to an agent with a secure WebSocket URL and streams correlated events', async () => {
		const { client, sockets } = socketClient();
		const agent = client.agents.connect('assistant bot', 'customer/123');
		const connection = sockets[0];
		expect(connection?.url).toBe('wss://flue.test/api/agents/assistant%20bot/customer%2F123');
		connection?.socket.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant bot',
			instanceId: 'customer/123',
		});
		await agent.ready;

		const events: unknown[] = [];
		agent.onEvent((event, context) => events.push({ event, context }));
		const options: AgentSocketPromptOptions = {};
		const pending = agent.prompt('Hello', options);
		await Promise.resolve();
		const request = JSON.parse(connection?.socket.sent[0] ?? '{}') as { requestId: string };
		expect(request).toMatchObject({
			version: 1,
			type: 'prompt',
			message: 'Hello',
		});
		const message: LlmMessage = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
		const output: LlmAssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'Hi' }],
		};
		connection?.socket.message({ version: 1, type: 'started', requestId: request.requestId });
		connection?.socket.message({
			version: 1,
			type: 'event',
			requestId: request.requestId,
			event: { type: 'agent_start', instanceId: 'customer/123', session: 'chat' },
		});
		connection?.socket.message({
			version: 1,
			type: 'event',
			requestId: request.requestId,
			event: {
				type: 'turn_request',
				instanceId: 'customer/123',
				session: 'chat',
				turnId: 'turn_1',
				purpose: 'agent',
				model: 'model',
				provider: 'provider',
				api: 'api',
				input: { messages: [message] },
			},
		});
		connection?.socket.message({
			version: 1,
			type: 'event',
			requestId: request.requestId,
			event: {
				type: 'turn',
				instanceId: 'customer/123',
				session: 'chat',
				turnId: 'turn_1',
				purpose: 'agent',
				durationMs: 1,
				output,
				isError: false,
			},
		});
		connection?.socket.message({
			version: 1,
			type: 'result',
			requestId: request.requestId,
			result: 'done',
		});

		await expect(pending).resolves.toEqual({ result: 'done' });
		expect(events).toEqual([
			{
				event: { type: 'agent_start', instanceId: 'customer/123', session: 'chat' },
				context: { requestId: request.requestId },
			},
			{
				event: {
					type: 'turn_request',
					instanceId: 'customer/123',
					session: 'chat',
					turnId: 'turn_1',
					purpose: 'agent',
					model: 'model',
					provider: 'provider',
					api: 'api',
					input: { messages: [message] },
				},
				context: { requestId: request.requestId },
			},
			{
				event: {
					type: 'turn',
					instanceId: 'customer/123',
					session: 'chat',
					turnId: 'turn_1',
					purpose: 'agent',
					durationMs: 1,
					output,
					isError: false,
				},
				context: { requestId: request.requestId },
			},
		]);
	});

	it('supports sequential agent prompts and ping on one socket', async () => {
		const { client, sockets } = socketClient();
		const agent = client.agents.connect('assistant', 'inst-1');
		const socket = sockets[0]?.socket;
		socket?.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'inst-1',
		});

		const first = agent.prompt('first');
		await Promise.resolve();
		const firstRequest = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({ version: 1, type: 'result', requestId: firstRequest.requestId, result: 1 });
		await expect(first).resolves.toEqual({ result: 1 });

		const second = agent.prompt('second');
		await Promise.resolve();
		const secondRequest = JSON.parse(socket?.sent[1] ?? '{}') as { requestId: string };
		socket?.message({ version: 1, type: 'result', requestId: secondRequest.requestId, result: 2 });
		await expect(second).resolves.toEqual({ result: 2 });

		const ping = agent.ping();
		await Promise.resolve();
		const pingRequest = JSON.parse(socket?.sent[2] ?? '{}') as { requestId: string };
		socket?.message({ version: 1, type: 'pong', requestId: pingRequest.requestId });
		await expect(ping).resolves.toBeUndefined();
	});

	it('rejects agent event frames that carry workflow identity or omit instance identity', async () => {
		for (const event of [
			{ type: 'agent_start' },
			{ type: 'agent_start', instanceId: 'inst-1', runId: 'run_stale' },
			{ type: 'run_start', instanceId: 'inst-1' },
			{ type: 'agent_start', instanceId: 'inst-2' },
			{ type: 'not_real', instanceId: 'inst-1' },
		]) {
			const { client, sockets } = socketClient();
			const agent = client.agents.connect('assistant', 'inst-1');
			const socket = sockets[0]?.socket;
			socket?.message({
				version: 1,
				type: 'ready',
				target: 'agent',
				name: 'assistant',
				instanceId: 'inst-1',
			});
			const pending = agent.prompt('hello');
			await Promise.resolve();
			const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
			socket?.message({ version: 1, type: 'event', requestId: request.requestId, event });
			await expect(pending).rejects.toThrow('invalid protocol message');
			expect(socket?.closeCalls).toEqual([{ code: 1008, reason: 'Invalid protocol message' }]);
		}
	});

	it('maps operation errors to FlueSocketError without closing an agent socket', async () => {
		const { client, sockets } = socketClient();
		const agent = client.agents.connect('assistant', 'inst-1');
		const socket = sockets[0]?.socket;
		socket?.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'inst-1',
		});
		const pending = agent.prompt('fail');
		await Promise.resolve();
		const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({
			version: 1,
			type: 'error',
			requestId: request.requestId,
			error: { type: 'TEST', message: 'failed', details: 'failed' },
		});
		await expect(pending).rejects.toBeInstanceOf(FlueSocketError);
		expect(socket?.closeCalls).toEqual([]);
	});

	it('closes on unscoped protocol errors and preserves the structured cause', async () => {
		const { client, sockets } = socketClient();
		const agent = client.agents.connect('assistant', 'inst-1');
		const socket = sockets[0]?.socket;
		socket?.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'inst-1',
		});
		socket?.message({
			version: 1,
			type: 'error',
			error: { type: 'PROTOCOL', message: 'bad frame', details: 'bad frame' },
		});
		expect(socket?.closeCalls).toEqual([{ code: 1011, reason: 'WebSocket error' }]);
		await expect(agent.prompt('after failure')).rejects.toBeInstanceOf(FlueSocketError);
	});

	it('invokes a workflow once and retains workflow run identity', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const connection = sockets[0];
		expect(connection?.url).toBe('wss://flue.test/api/workflows/triage');
		connection?.socket.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		const events: unknown[] = [];
		workflow.onEvent((event, context) => events.push({ event, context }));
		const pending = workflow.invoke({ issue: 123 });
		await Promise.resolve();
		const request = JSON.parse(connection?.socket.sent[0] ?? '{}') as { requestId: string };
		expect(request).toMatchObject({ version: 1, type: 'invoke', payload: { issue: 123 } });
		connection?.socket.message({
			version: 1,
			type: 'started',
			requestId: request.requestId,
			runId: 'run_workflow',
		});
		await expect(workflow.runId).resolves.toBe('run_workflow');
		connection?.socket.message({
			version: 1,
			type: 'event',
			requestId: request.requestId,
			runId: 'run_workflow',
			event: { type: 'text_delta', text: 'working' },
		});
		connection?.socket.message({
			version: 1,
			type: 'result',
			requestId: request.requestId,
			runId: 'run_workflow',
			result: { ok: true },
		});
		await expect(pending).resolves.toEqual({ result: { ok: true }, runId: 'run_workflow' });
		expect(events).toEqual([
			{
				event: { type: 'text_delta', text: 'working' },
				context: { requestId: request.requestId, runId: 'run_workflow' },
			},
		]);
		await expect(workflow.invoke({ issue: 456 })).rejects.toThrow('only one invocation');
	});

	it('preserves workflow run identity on run-scoped socket errors', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const socket = sockets[0]?.socket;
		socket?.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		const pending = workflow.invoke({ issue: 123 });
		await Promise.resolve();
		const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({
			version: 1,
			type: 'error',
			requestId: request.requestId,
			runId: 'run_workflow',
			error: { type: 'TEST', message: 'failed', details: 'failed' },
		});
		const error = await pending.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(FlueSocketError);
		expect(error).toMatchObject({ requestId: request.requestId, runId: 'run_workflow' });
		await expect(workflow.runId).rejects.toBe(error);
	});

	it('rejects workflow run identity when the socket closes before invocation', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const socket = sockets[0]?.socket;
		socket?.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		socket?.closed();
		await expect(workflow.runId).rejects.toThrow('connection closed');
	});

	it('rejects workflow results received before admission', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const socket = sockets[0]?.socket;
		socket?.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		const pending = workflow.invoke({ issue: 123 });
		await Promise.resolve();
		const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({
			version: 1,
			type: 'result',
			requestId: request.requestId,
			runId: 'run_workflow',
			result: { ok: true },
		});
		await expect(workflow.runId).rejects.toThrow('invalid protocol message');
		await expect(pending).rejects.toThrow('invalid protocol message');
		expect(socket?.closeCalls).toEqual([{ code: 1008, reason: 'Invalid protocol message' }]);
	});

	it('retains admitted workflow run identity after connection loss', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const socket = sockets[0]?.socket;
		socket?.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		const pending = workflow.invoke({ issue: 123 });
		await Promise.resolve();
		const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({
			version: 1,
			type: 'started',
			requestId: request.requestId,
			runId: 'run_workflow',
		});
		await expect(workflow.runId).resolves.toBe('run_workflow');
		socket?.closed();
		await expect(pending).rejects.toThrow('connection closed');
		await expect(workflow.runId).resolves.toBe('run_workflow');
	});

	it('rejects workflow frames that omit required run identity', async () => {
		const { client, sockets } = socketClient();
		const workflow = client.workflows.connect('triage');
		const socket = sockets[0]?.socket;
		socket?.message({ version: 1, type: 'ready', target: 'workflow', name: 'triage' });
		const pending = workflow.invoke({ issue: 123 });
		await Promise.resolve();
		const request = JSON.parse(socket?.sent[0] ?? '{}') as { requestId: string };
		socket?.message({
			version: 1,
			type: 'result',
			requestId: request.requestId,
			result: { ok: true },
		});
		await expect(pending).rejects.toThrow('invalid protocol message');
		expect(socket?.closeCalls).toEqual([{ code: 1008, reason: 'Invalid protocol message' }]);
	});

	it('fails pending work on invalid server protocol frames or connection close', async () => {
		const invalid = socketClient();
		const invalidAgent = invalid.client.agents.connect('assistant', 'inst-1');
		const invalidSocket = invalid.sockets[0]?.socket;
		invalidSocket?.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'inst-1',
		});
		const invalidPending = invalidAgent.prompt('hello');
		await Promise.resolve();
		invalidSocket?.message({ version: 1, type: 'event', requestId: 'request' });
		await expect(invalidPending).rejects.toThrow('invalid protocol message');
		expect(invalidSocket?.closeCalls).toEqual([{ code: 1008, reason: 'Invalid protocol message' }]);

		const disconnected = socketClient();
		const disconnectedAgent = disconnected.client.agents.connect('assistant', 'inst-1');
		const disconnectedSocket = disconnected.sockets[0]?.socket;
		disconnectedSocket?.message({
			version: 1,
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'inst-1',
		});
		const disconnectedPending = disconnectedAgent.prompt('hello');
		await Promise.resolve();
		disconnectedSocket?.closed();
		await expect(disconnectedPending).rejects.toThrow('connection closed');
	});
});
