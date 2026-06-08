import { describe, expect, it, vi } from 'vitest';

import { createFlueContext } from '../src/client.ts';
import {
	type CloudflareWebSocketAttachment,
	type CloudflareWebSocketConnection,
	connectCloudflareAgentWebSocket,
	connectCloudflareWorkflowWebSocket,
	messageCloudflareAgentWebSocket,
	messageCloudflareWorkflowWebSocket,
} from '../src/cloudflare/websocket.ts';
import { InMemoryRunStore } from '../src/node/run-store.ts';
import { InMemorySessionStore } from '../src/session.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

describe('Cloudflare agent WebSockets', () => {
	it('persists only the agent operation URL when a Cloudflare agent socket connects', () => {
		const connection = new TestConnection();

		connectCloudflareAgentWebSocket(connection, {
			name: 'assistant',
			id: 'agent-instance-1',
			requestUrl: 'https://example.com/flue/agents/assistant/agent-instance-1?token=secret#section',
		});

		expect(connection.attachment).toEqual({
			version: 1,
			target: 'agent',
			name: 'assistant',
			id: 'agent-instance-1',
			requestUrl: 'https://example.com/flue/agents/assistant/agent-instance-1',
		});
	});

	it('sends an agent ready frame when a Cloudflare agent socket connects', () => {
		const connection = new TestConnection();

		connectCloudflareAgentWebSocket(connection, {
			name: 'assistant',
			id: 'agent-instance-1',
			requestUrl: 'https://example.com/flue/agents/assistant/agent-instance-1',
		});

		expect(connection.messages).toEqual([
			{
				version: 1,
				type: 'ready',
				target: 'agent',
				name: 'assistant',
				instanceId: 'agent-instance-1',
			},
		]);
	});

	it('replies with pong when a Cloudflare agent socket receives ping', async () => {
		const connection = new TestConnection();

		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'ping', requestId: 'ping-1' }),
			{
				name: 'assistant',
				id: 'agent-instance-1',
				request: new Request('https://example.com/flue/agents/assistant/agent-instance-1'),
				handler: async () => null,
				createContext,
				admitAttachedSubmission: async () => null,
			},
		);

		expect(connection.messages).toEqual([{ version: 1, type: 'pong', requestId: 'ping-1' }]);
		expect(connection.closed).toBeUndefined();
	});

	// The inline handler invocation test was removed because agent prompts now
	// always go through the durable admission hook. Handler execution is covered
	// by the coordinator test suite.

	it('uses attached durable submission admission when configured for a Cloudflare agent socket', async () => {
		const connection = new TestConnection();
		const calls: string[] = [];

		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'prompt', requestId: 'prompt-1', message: 'Hello' }),
			{
				name: 'assistant',
				id: 'agent-instance-1',
				request: new Request('https://example.com/flue/agents/assistant/agent-instance-1'),
				handler: async () => {
					calls.push('handler');
					return null;
				},
				createContext,
				admitAttachedSubmission: async (payload, onEvent) => {
					calls.push(`admit:${payload.message}`);
					await onEvent?.({ type: 'idle', instanceId: 'agent-instance-1' });
					return 'done';
				},
			},
		);

		expect(calls).toEqual(['admit:Hello']);
		expect(connection.messages).toEqual([
			{ version: 1, type: 'started', requestId: 'prompt-1' },
			{
				version: 1,
				type: 'event',
				requestId: 'prompt-1',
				event: { type: 'idle', instanceId: 'agent-instance-1' },
			},
			{ version: 1, type: 'result', requestId: 'prompt-1', result: 'done' },
		]);
	});

	it('allows durable attached admission to complete when the Cloudflare agent socket disconnects', async () => {
		const connection = new ThrowingConnection();
		const calls: string[] = [];

		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'prompt', requestId: 'prompt-disconnected', message: 'Hello' }),
			{
				name: 'assistant',
				id: 'agent-instance-1',
				request: new Request('https://example.com/flue/agents/assistant/agent-instance-1'),
				handler: async () => null,
				createContext,
				admitAttachedSubmission: async (_payload, onEvent) => {
					calls.push('admitted');
					await onEvent?.({ type: 'idle', instanceId: 'agent-instance-1' });
					calls.push('completed');
					return 'done';
				},
			},
		);

		expect(calls).toEqual(['admitted', 'completed']);
	});

	it('rejects oversized messages when a Cloudflare agent socket exceeds the byte limit', async () => {
		const connection = new TestConnection();
		let invocations = 0;

		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'prompt',
				requestId: 'prompt-large',
				message: 'x'.repeat(1024 * 1024),
			}),
			{
				name: 'assistant',
				id: 'agent-instance-1',
				request: new Request('https://example.com/flue/agents/assistant/agent-instance-1'),
				handler: async () => {
					invocations++;
					return null;
				},
				createContext,
				admitAttachedSubmission: async () => null,
			},
		);

		expect(connection.messages).toEqual([
			{
				version: 1,
				type: 'error',
				error: {
					type: 'invalid_request',
					message: 'Request is malformed.',
					details: 'WebSocket messages must not exceed 1048576 bytes.',
				},
			},
		]);
		expect(connection.closed).toEqual({ code: 1008, reason: 'Message too large' });
		expect(invocations).toBe(0);
	});

	it('rejects binary messages when a Cloudflare agent socket receives non-text input', async () => {
		const connection = new TestConnection();
		let invocations = 0;

		await messageCloudflareAgentWebSocket(connection, new Uint8Array([1, 2, 3]), {
			name: 'assistant',
			id: 'agent-instance-1',
			request: new Request('https://example.com/flue/agents/assistant/agent-instance-1'),
			handler: async () => {
				invocations++;
				return null;
			},
			createContext,
			admitAttachedSubmission: async () => null,
		});

		expect(connection.messages).toEqual([
			{
				version: 1,
				type: 'error',
				error: {
					type: 'invalid_request',
					message: 'Request is malformed.',
					details: 'Binary WebSocket messages are not supported.',
				},
			},
		]);
		expect(connection.closed).toEqual({ code: 1003, reason: 'Binary messages are not supported' });
		expect(invocations).toBe(0);
	});

	// The error propagation test was removed because agent prompts now always
	// go through the durable admission hook. Error handling through the
	// submission lifecycle is covered by the coordinator test suite.
});

describe('Cloudflare workflow WebSockets', () => {
	it('persists only the workflow operation URL when a Cloudflare workflow socket connects', () => {
		const connection = new TestConnection();

		connectCloudflareWorkflowWebSocket(connection, {
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize?token=secret#section',
		});

		expect(connection.attachment).toEqual({
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: false,
		});
	});

	it('accepts the first workflow invocation when a restored socket has not previously invoked', async () => {
		const connection = new TestConnection();
		connection.attachment = {
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: false,
		};
		let admissions = 0;
		let payload: unknown;

		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'workflow-request-1',
				payload: { topic: 'support' },
			}),
			{
				name: 'summarize',
				runId: 'workflow:summarize:run-1',
				request: new Request('https://example.com/flue/workflows/summarize'),
				handler: async (ctx) => {
					payload = ctx.payload;
					return 'done';
				},
				createContext,
				startWorkflowAdmission: async (runId, run) => {
					expect(runId).toBe('workflow:summarize:run-1');
					admissions++;
					return run();
				},
				runStore: new InMemoryRunStore(),
			},
		);

		expect(connection.attachment).toEqual({
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: true,
		});
		expect(admissions).toBe(1);
		expect(payload).toEqual({ topic: 'support' });
		expect(connection.messages).toContainEqual({
			version: 1,
			type: 'started',
			requestId: 'workflow-request-1',
			runId: 'workflow:summarize:run-1',
		});
	});

	it('rejects a second invocation when restored workflow socket state is already invoked', async () => {
		const connection = new TestConnection();
		connection.attachment = {
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: true,
		};
		let invocations = 0;

		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'workflow-request-2',
				payload: null,
			}),
			{
				name: 'summarize',
				runId: 'workflow:summarize:run-1',
				request: new Request('https://example.com/flue/workflows/summarize'),
				handler: async () => {
					invocations++;
					return null;
				},
				createContext,
				startWorkflowAdmission: async (_runId, run) => run(),
				runStore: new InMemoryRunStore(),
			},
		);

		expect(connection.messages).toEqual([
			{
				version: 1,
				type: 'error',
				requestId: 'workflow-request-2',
				error: {
					type: 'invalid_request',
					message: 'Request is malformed.',
					details: 'Workflow WebSocket connections accept one invocation only.',
				},
			},
		]);
		expect(connection.closed).toEqual({
			code: 1008,
			reason: 'Workflow accepts one invocation only',
		});
		expect(invocations).toBe(0);
	});

	it('rejects oversized messages when a Cloudflare workflow socket exceeds the byte limit', async () => {
		const connection = new TestConnection();
		connection.attachment = {
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: false,
		};
		let invocations = 0;

		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'workflow-request-large',
				payload: 'x'.repeat(1024 * 1024),
			}),
			{
				name: 'summarize',
				runId: 'workflow:summarize:run-1',
				request: new Request('https://example.com/flue/workflows/summarize'),
				handler: async () => {
					invocations++;
					return null;
				},
				createContext,
				startWorkflowAdmission: async (_runId, run) => run(),
				runStore: new InMemoryRunStore(),
			},
		);

		expect(connection.messages).toEqual([
			{
				version: 1,
				type: 'error',
				error: {
					type: 'invalid_request',
					message: 'Request is malformed.',
					details: 'WebSocket messages must not exceed 1048576 bytes.',
				},
			},
		]);
		expect(connection.attachment).toEqual({
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: false,
		});
		expect(connection.closed).toEqual({ code: 1008, reason: 'Message too large' });
		expect(invocations).toBe(0);
	});

	it('closes successfully when a Cloudflare workflow socket delivers its result', async () => {
		const connection = new TestConnection();
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
		});

		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'workflow-request-result',
				payload: { topic: 'support' },
			}),
			{
				name: 'summarize',
				runId: 'workflow:summarize:run-1',
				request: new Request('https://example.com/flue/workflows/summarize'),
				handler: async () => ({ summary: 'Resolved' }),
				createContext,
				startWorkflowAdmission: async (_runId, run) => run(),
				runStore: new InMemoryRunStore(),
			},
		);

		expect(connection.messages).toContainEqual({
			version: 1,
			type: 'result',
			requestId: 'workflow-request-result',
			runId: 'workflow:summarize:run-1',
			result: { summary: 'Resolved' },
		});
		expect(connection.closed).toEqual({ code: 1000, reason: 'Workflow completed' });
	});

	it('closes with failure when a Cloudflare workflow invocation throws', async () => {
		const connection = new TestConnection();
		connection.attachment = {
			version: 1,
			target: 'workflow',
			name: 'summarize',
			runId: 'workflow:summarize:run-1',
			requestUrl: 'https://example.com/flue/workflows/summarize',
			invoked: false,
		};
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await messageCloudflareWorkflowWebSocket(
				connection,
				JSON.stringify({
					version: 1,
					type: 'invoke',
					requestId: 'workflow-request-failure',
					payload: { topic: 'support' },
				}),
				{
					name: 'summarize',
					runId: 'workflow:summarize:run-1',
					request: new Request('https://example.com/flue/workflows/summarize'),
					handler: async () => {
						throw new Error('database password leaked');
					},
					createContext,
					startWorkflowAdmission: async (_runId, run) => run(),
					runStore: new InMemoryRunStore(),
				},
			);
		} finally {
			consoleError.mockRestore();
		}

		expect(connection.messages).toContainEqual({
			version: 1,
			type: 'error',
			requestId: 'workflow-request-failure',
			runId: 'workflow:summarize:run-1',
			error: {
				type: 'internal_error',
				message: 'An internal error occurred.',
				details: 'The server encountered an unexpected error while handling this request.',
			},
		});
		expect(connection.closed).toEqual({ code: 1011, reason: 'Workflow failed' });
	});
});

class ThrowingConnection implements CloudflareWebSocketConnection {
	serializeAttachment(): void {}

	deserializeAttachment(): CloudflareWebSocketAttachment | null {
		return null;
	}

	send(): void {
		throw new Error('Socket disconnected');
	}

	close(): void {}
}

class TestConnection implements CloudflareWebSocketConnection {
	attachment: CloudflareWebSocketAttachment | null = null;
	messages: WebSocketServerMessage[] = [];
	closed: { code?: number; reason?: string } | undefined;

	serializeAttachment(attachment: CloudflareWebSocketAttachment): void {
		this.attachment = attachment;
	}

	deserializeAttachment(): CloudflareWebSocketAttachment | null {
		return this.attachment;
	}

	send(message: string): void {
		this.messages.push(JSON.parse(message) as WebSocketServerMessage);
	}

	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
}

function createContext(id: string, runId: string | undefined, payload: unknown, request: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req: request,
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
