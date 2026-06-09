import { describe, expect, it } from 'vitest';
import {
	type AgentInvokeOptions,
	type AgentStreamInvokeOptions,
	type AgentSyncInvokeOptions,
	type AttachedAgentEvent,
	createFlueClient,
	FlueApiError,
	type ListRunsOptions,
	type LlmAssistantMessage,
	type LlmMessage,
	type RunEventsOptions,
	type RunStatus,
	type RunStreamOptions,
} from '../src/index.ts';
import { readSse } from '../src/public/stream.ts';

describe('createFlueClient', () => {
	it('sends sync agent prompt requests without run identity', async () => {
		const seen: Request[] = [];
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async (input, init) => {
				seen.push(new Request(input, init));
				return Response.json({ result: { ok: true } });
			},
		});

		const options: AgentSyncInvokeOptions = {
			mode: 'sync',
			payload: { message: 'Hello' },
		};

		await expect(client.agents.invoke('hello', 'inst-1', options)).resolves.toEqual({
			result: { ok: true },
		});
		expect(seen).toHaveLength(1);
		expect(new URL(seen[0]?.url ?? '').pathname).toBe('/agents/hello/inst-1');
		expect(seen[0]?.method).toBe('POST');
		expect(await seen[0]?.json()).toEqual({ message: 'Hello' });
	});

	it('resolves public HTTP and SSE routes beneath the base URL pathname', async () => {
		const requests: Request[] = [];
		const client = createFlueClient({
			baseUrl: 'https://flue.test/api/',
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith('/stream')) {
					return new Response(
						sse('event: run_end\ndata: {"type":"run_end","isError":false,"durationMs":1}\n\n'),
						{
							headers: { 'content-type': 'text/event-stream' },
						},
					);
				}
				if (request.headers.get('accept') === 'text/event-stream') {
					return new Response(sse('event: idle\ndata: {"type":"idle","instanceId":"inst-1"}\n\n'), {
						headers: { 'content-type': 'text/event-stream' },
					});
				}
				if (request.url.endsWith('/events')) return Response.json({ events: [] });
				if (request.method === 'POST') return Response.json({ result: { ok: true } });
				return Response.json({ runId: 'run-1' });
			},
		});

		await client.agents.invoke('hello', 'inst-1', { mode: 'sync', payload: { message: 'Hello' } });
		const agentEvents = [];
		for await (const event of client.agents.invoke('hello', 'inst-1', {
			mode: 'stream',
			payload: { message: 'Hello' },
		}))
			agentEvents.push(event);
		await client.runs.get('run-1');
		const runEventOptions: RunEventsOptions = {};
		await client.runs.events('run-1', runEventOptions);
		const runEvents = [];
		for await (const event of client.runs.stream('run-1')) runEvents.push(event);

		expect(agentEvents).toEqual([{ type: 'idle', instanceId: 'inst-1' }]);
		expect(runEvents).toEqual([{ type: 'run_end', isError: false, durationMs: 1 }]);
		expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
			'/api/agents/hello/inst-1',
			'/api/agents/hello/inst-1',
			'/api/runs/run-1',
			'/api/runs/run-1/events',
			'/api/runs/run-1/stream',
		]);
	});

	it('exposes structured HTTP API errors', async () => {
		const body = {
			error: {
				type: 'agent_not_found',
				message: 'Agent not found.',
				details: 'No exposed agent named hello exists.',
			},
		};
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => Response.json(body, { status: 404 }),
		});

		const error = await client.agents
			.invoke('hello', 'inst-1', { mode: 'sync', payload: { message: 'Hello' } })
			.catch((error: unknown) => error);

		expect(error).toBeInstanceOf(FlueApiError);
		if (!(error instanceof FlueApiError)) throw error;
		expect(error.name).toBe('FlueApiError');
		expect(error.status).toBe(404);
		expect(error.body).toEqual(body);
		expect(error.message).toBe('Flue API error 404 [agent_not_found]: Agent not found.');
	});

	it('preserves parsed null HTTP API error bodies', async () => {
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => Response.json(null, { status: 500 }),
		});

		const error = await client.runs.get('run-1').catch((error: unknown) => error);

		expect(error).toBeInstanceOf(FlueApiError);
		if (!(error instanceof FlueApiError)) throw error;
		expect(error.body).toBeNull();
	});

	it('streams attached agent events without workflow identity', async () => {
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(
					sse(
						'event: agent_start\ndata: {"type":"agent_start","instanceId":"inst-1","session":"chat"}\n\nevent: idle\ndata: {"type":"idle","instanceId":"inst-1","session":"chat"}\n\n',
					),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				),
		});

		const events = [];
		const options: AgentStreamInvokeOptions = {
			mode: 'stream',
			payload: { message: 'Hello' },
		};
		const invoke = (options: AgentInvokeOptions) =>
			client.agents.invoke('hello', 'inst-1', options);
		for await (const event of invoke(options) as AsyncIterable<AttachedAgentEvent>) {
			events.push(event);
		}
		expect(events).toEqual([
			{ type: 'agent_start', instanceId: 'inst-1', session: 'chat' },
			{ type: 'idle', instanceId: 'inst-1', session: 'chat' },
		]);
	});

	it('streams normalized model-turn content for attached agents', async () => {
		const userMessage: LlmMessage = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
		const output: LlmAssistantMessage = {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'checking' },
				{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'hello' } },
			],
		};
		const request: AttachedAgentEvent = {
			type: 'turn_request',
			instanceId: 'inst-1',
			session: 'chat',
			turnId: 'turn_1',
			purpose: 'agent',
			model: 'model',
			provider: 'provider',
			api: 'api',
			input: {
				messages: [userMessage],
				tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
			},
		};
		const turn: AttachedAgentEvent = {
			type: 'turn',
			instanceId: 'inst-1',
			session: 'chat',
			turnId: 'turn_1',
			purpose: 'agent',
			durationMs: 1,
			output,
			isError: false,
		};
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(
					sse(
						`event: turn_request\ndata: ${JSON.stringify(request)}\n\nevent: turn\ndata: ${JSON.stringify(turn)}\n\n`,
					),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				),
		});

		const events: AttachedAgentEvent[] = [];
		for await (const event of client.agents.invoke('hello', 'inst-1', {
			mode: 'stream',
			payload: { message: 'Hello' },
		})) {
			events.push(event);
		}
		expect(events).toEqual([request, turn]);
		expect(events[0]?.type === 'turn_request' && events[0].input.messages[0]).toEqual(userMessage);
		expect(events[1]?.type === 'turn' && events[1].output).toEqual(output);
	});

	it('rejects invalid attached agent stream events and stream errors', async () => {
		const invalid = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(sse('event: run_start\ndata: {"type":"run_start","runId":"run_stale"}\n\n'), {
					headers: { 'content-type': 'text/event-stream' },
				}),
		});
		const invalidEvents = invalid.agents.invoke('hello', 'inst-1', {
			mode: 'stream',
			payload: { message: 'Hello' },
		});
		await expect(
			(async () => {
				for await (const _event of invalidEvents) return;
			})(),
		).rejects.toThrow('invalid event');

		for (const data of [
			'{"type":"agent_start","instanceId":"inst-2"}',
			'{"type":"not_real","instanceId":"inst-1"}',
		]) {
			const mismatch = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					new Response(sse(`event: agent_start\ndata: ${data}\n\n`), {
						headers: { 'content-type': 'text/event-stream' },
					}),
			});
			const events = mismatch.agents.invoke('hello', 'inst-1', {
				mode: 'stream',
				payload: { message: 'Hello' },
			});
			await expect(
				(async () => {
					for await (const _event of events) return;
				})(),
			).rejects.toThrow('invalid event');
		}

		const failed = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(
					sse(
						'event: error\ndata: {"type":"error","instanceId":"inst-1","error":{"type":"internal_error","message":"agent failed","details":"failed"}}\n\n',
					),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				),
		});
		const failedEvents = failed.agents.invoke('hello', 'inst-1', {
			mode: 'stream',
			payload: { message: 'Hello' },
		});
		await expect(
			(async () => {
				for await (const _event of failedEvents) return;
			})(),
		).rejects.toThrow('agent failed');
	});

	it('builds origin-relative admin list queries independently from the public mount', async () => {
		let url = '';
		const client = createFlueClient({
			baseUrl: 'https://flue.test/api/',
			fetch: async (input) => {
				url = new Request(input).url;
				return Response.json({ items: [] });
			},
		});

		const status: RunStatus = 'active';
		const options: ListRunsOptions = { status, workflowName: 'hello', limit: 10 };

		await client.admin.runs.list(options);
		const parsed = new URL(url);
		expect(parsed.pathname).toBe('/admin/runs');
		expect(parsed.searchParams.get('status')).toBe('active');
		expect(parsed.searchParams.get('workflowName')).toBe('hello');
		expect(parsed.searchParams.get('limit')).toBe('10');
	});

	it('supports admin mounted below a custom path', async () => {
		let url = '';
		const client = createFlueClient({
			baseUrl: 'https://flue.test/api/',
			adminBasePath: '/internal/admin/',
			fetch: async (input) => {
				url = new Request(input).url;
				return Response.json({ items: [] });
			},
		});

		await client.admin.agents.list();
		expect(new URL(url).pathname).toBe('/internal/admin/agents');
	});

	it('rejects run-stream SSE error frames instead of yielding them as events', async () => {
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(
					sse(
						'event: error\nid: 1\ndata: {"error":{"type":"internal_error","message":"stream failed","details":"failed"}}\n\n',
					),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				),
		});
		const events: unknown[] = [];
		const options: RunStreamOptions = { maxRetries: 0 };
		await expect(
			(async () => {
				for await (const event of client.runs.stream('run_1', options)) events.push(event);
			})(),
		).rejects.toThrow('stream failed');
		expect(events).toEqual([]);
	});

	it('uses a fallback error for run-stream SSE error frames without messages', async () => {
		for (const data of ['null', '{}']) {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					new Response(sse(`event: error\nid: 1\ndata: ${data}\n\n`), {
						headers: { 'content-type': 'text/event-stream' },
					}),
			});
			await expect(
				(async () => {
					for await (const _event of client.runs.stream('run_1', { maxRetries: 0 })) return;
				})(),
			).rejects.toThrow('SSE stream failed.');
		}
	});

	it('ignores malformed SSE ids when reconnecting workflow-run streams', async () => {
		const requests: Request[] = [];
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (requests.length === 1) {
					return new Response(sse('event: run_start\nid: 1junk\ndata: {"type":"run_start"}\n\n'), {
						headers: { 'content-type': 'text/event-stream' },
					});
				}
				return new Response(
					sse('event: run_end\nid: 2\ndata: {"type":"run_end","isError":false,"durationMs":1}\n\n'),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				);
			},
		});

		// Exhaust the iterator so the stream reconnects; this test only inspects the resumed request header.
		for await (const _event of client.runs.stream('run_1', { maxRetries: 1, initialRetryMs: 1 })) {
		}

		expect(requests).toHaveLength(2);
		expect(requests[1]?.headers.get('last-event-id')).toBeNull();
	});

	it('cancels the workflow-run SSE response when iteration stops before run_end', async () => {
		let cancellations = 0;
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('event: run_start\nid: 1\ndata: {"type":"run_start"}\n\n'),
							);
						},
						cancel() {
							cancellations++;
						},
					}),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				),
		});

		for await (const _event of client.runs.stream('run_1')) break;

		expect(cancellations).toBe(1);
	});

	it('reconnects run streams after clean EOF before run_end', async () => {
		const requests: Request[] = [];
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (requests.length === 1) {
					return new Response(sse('event: run_start\nid: 1\ndata: {"type":"run_start"}\n\n'), {
						headers: { 'content-type': 'text/event-stream' },
					});
				}
				return new Response(
					sse('event: run_end\nid: 2\ndata: {"type":"run_end","isError":false,"durationMs":1}\n\n'),
					{
						headers: { 'content-type': 'text/event-stream' },
					},
				);
			},
		});

		const events = [];
		for await (const event of client.runs.stream('run_1', { maxRetries: 1, initialRetryMs: 1 })) {
			events.push(event.type);
		}

		expect(events).toEqual(['run_start', 'run_end']);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.headers.get('last-event-id')).toBe('1');
	});
});

describe('readSse', () => {
	it('parses SSE frames', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode('event: run_end\nid: 2\ndata: {"type":"run_end"}\n\n'),
				);
				controller.close();
			},
		});

		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([{ event: 'run_end', id: '2', data: '{"type":"run_end"}' }]);
	});

	it('parses CRLF-delimited SSE frames', async () => {
		const stream = sse('event: run_end\r\nid: 2\r\ndata: {"type":"run_end"}\r\n\r\n');

		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([{ event: 'run_end', id: '2', data: '{"type":"run_end"}' }]);
	});

	it('parses CR-only line endings', async () => {
		const stream = sse('event: run_end\rid: 2\rdata: {"type":"run_end"}\r\r');

		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([{ event: 'run_end', id: '2', data: '{"type":"run_end"}' }]);
	});

	it('handles CRLF split across chunks', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// First chunk ends with \r, second chunk starts with \n
				controller.enqueue(encoder.encode('data: {"type":"a"}\r'));
				controller.enqueue(encoder.encode('\ndata: {"type":"b"}\r'));
				controller.enqueue(encoder.encode('\n\r\n'));
				controller.close();
			},
		});

		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([{ data: '{"type":"a"}\n{"type":"b"}' }]);
	});

	it('handles multiple frames across many small chunks', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"n":1}\r\n'));
				controller.enqueue(encoder.encode('\r\ndata:'));
				controller.enqueue(encoder.encode(' {"n":2}\r\n\r\n'));
				controller.close();
			},
		});

		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([{ data: '{"n":1}' }, { data: '{"n":2}' }]);
	});
});

function sse(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}
