import { describe, expect, it } from 'vitest';
import { type AttachedAgentEvent, createFlueClient, type LlmAssistantMessage, type LlmMessage } from '../src/index.ts';
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
		const tools = [{
			name: 'lookup',
			description: 'Look up client-visible data.',
			parameters: { type: 'object', properties: { query: { type: 'string' } } },
			kind: 'client' as const,
		}];

		await expect(
			client.agents.invoke('hello', 'inst-1', { mode: 'sync', payload: { message: 'Hello', session: 'chat', tools } }),
		).resolves.toEqual({ result: { ok: true } });
		expect(seen).toHaveLength(1);
		expect(new URL(seen[0]?.url ?? '').pathname).toBe('/agents/hello/inst-1');
		expect(seen[0]?.method).toBe('POST');
		expect(await seen[0]?.json()).toEqual({ message: 'Hello', session: 'chat', tools });
	});

	it('streams attached agent events without workflow identity', async () => {
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => new Response(sse('event: agent_start\ndata: {"type":"agent_start","instanceId":"inst-1","session":"chat"}\n\nevent: idle\ndata: {"type":"idle","instanceId":"inst-1","session":"chat"}\n\n'), {
				headers: { 'content-type': 'text/event-stream' },
			}),
		});

		const events = [];
		for await (const event of client.agents.invoke('hello', 'inst-1', { mode: 'stream', payload: { message: 'Hello', session: 'chat' } })) {
			events.push(event);
		}
			expect(events).toEqual([{ type: 'agent_start', instanceId: 'inst-1', session: 'chat' }, { type: 'idle', instanceId: 'inst-1', session: 'chat' }]);
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
		const request: AttachedAgentEvent = { type: 'turn_request', instanceId: 'inst-1', session: 'chat', turnId: 'turn_1', purpose: 'agent', model: 'model', provider: 'provider', api: 'api', input: { messages: [userMessage], tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }] } };
		const turn: AttachedAgentEvent = { type: 'turn', instanceId: 'inst-1', session: 'chat', turnId: 'turn_1', purpose: 'agent', durationMs: 1, output, isError: false };
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => new Response(sse(`event: turn_request\ndata: ${JSON.stringify(request)}\n\nevent: turn\ndata: ${JSON.stringify(turn)}\n\n`), {
				headers: { 'content-type': 'text/event-stream' },
			}),
		});

		const events: AttachedAgentEvent[] = [];
		for await (const event of client.agents.invoke('hello', 'inst-1', { mode: 'stream', payload: { message: 'Hello', session: 'chat' } })) {
			events.push(event);
		}
		expect(events).toEqual([request, turn]);
		expect(events[0]?.type === 'turn_request' && events[0].input.messages[0]).toEqual(userMessage);
		expect(events[1]?.type === 'turn' && events[1].output).toEqual(output);
	});

	it('rejects invalid attached agent stream events and stream errors', async () => {
		const invalid = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => new Response(sse('event: run_start\ndata: {"type":"run_start","runId":"run_stale"}\n\n'), {
				headers: { 'content-type': 'text/event-stream' },
			}),
		});
		const invalidEvents = invalid.agents.invoke('hello', 'inst-1', { mode: 'stream', payload: { message: 'Hello' } });
		await expect((async () => { for await (const _event of invalidEvents) return; })()).rejects.toThrow('invalid event');

		for (const data of [
			'{"type":"agent_start","instanceId":"inst-2"}',
			'{"type":"not_real","instanceId":"inst-1"}',
		]) {
			const mismatch = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => new Response(sse(`event: agent_start\ndata: ${data}\n\n`), {
					headers: { 'content-type': 'text/event-stream' },
				}),
			});
			const events = mismatch.agents.invoke('hello', 'inst-1', { mode: 'stream', payload: { message: 'Hello' } });
			await expect((async () => { for await (const _event of events) return; })()).rejects.toThrow('invalid event');
		}

		const failed = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => new Response(sse('event: error\ndata: {"type":"error","instanceId":"inst-1","error":{"type":"internal_error","message":"agent failed","details":"failed"}}\n\n'), {
				headers: { 'content-type': 'text/event-stream' },
			}),
		});
		const failedEvents = failed.agents.invoke('hello', 'inst-1', { mode: 'stream', payload: { message: 'Hello' } });
		await expect((async () => { for await (const _event of failedEvents) return; })()).rejects.toThrow('agent failed');
	});

	it('builds admin list queries', async () => {
		let url = '';
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async (input) => {
				url = new Request(input).url;
				return Response.json({ items: [] });
			},
		});

		await client.admin.runs.list({ status: 'active', workflowName: 'hello', limit: 10 });
		const parsed = new URL(url);
		expect(parsed.pathname).toBe('/admin/runs');
		expect(parsed.searchParams.get('status')).toBe('active');
		expect(parsed.searchParams.get('workflowName')).toBe('hello');
		expect(parsed.searchParams.get('limit')).toBe('10');
	});

	it('exposes workflow restart linkage in run records', async () => {
		const record = {
			runId: 'run-next',
			owner: { kind: 'workflow' as const, workflowName: 'report', instanceId: 'run-next' },
			status: 'completed' as const,
			startedAt: '2026-05-27T00:00:00.000Z',
			restartedFromRunId: 'run-before',
			restartedAsRunId: 'run-after',
		};
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async () => Response.json(record),
		});

		const run = await client.runs.get('run-next');
		const adminRun = await client.admin.runs.get('run-next');

		expect(run.restartedFromRunId).toBe('run-before');
		expect(adminRun.restartedAsRunId).toBe('run-after');
	});

	it('supports admin mounted below a custom path', async () => {
		let url = '';
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
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
			fetch: async () => new Response(sse('event: error\nid: 1\ndata: {"message":"stream failed"}\n\n'), {
				headers: { 'content-type': 'text/event-stream' },
			}),
		});
		const events: unknown[] = [];
		await expect((async () => {
			for await (const event of client.runs.stream('run_1', { maxRetries: 0 })) events.push(event);
		})()).rejects.toThrow('stream failed');
		expect(events).toEqual([]);
	});

	it('uses a fallback error for run-stream SSE error frames without messages', async () => {
		for (const data of ['null', '{}']) {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => new Response(sse(`event: error\nid: 1\ndata: ${data}\n\n`), {
					headers: { 'content-type': 'text/event-stream' },
				}),
			});
			await expect((async () => {
				for await (const _event of client.runs.stream('run_1', { maxRetries: 0 })) return;
			})()).rejects.toThrow('SSE stream failed.');
		}
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
				return new Response(sse('event: run_end\nid: 2\ndata: {"type":"run_end","isError":false,"durationMs":1}\n\n'), {
					headers: { 'content-type': 'text/event-stream' },
				});
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
				controller.enqueue(new TextEncoder().encode('event: run_end\nid: 2\ndata: {"type":"run_end"}\n\n'));
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
});

function sse(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}
