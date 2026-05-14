import { describe, expect, it } from 'vitest';
import { createFlueClient } from '../src/index.ts';
import { readSse } from '../src/public/stream.ts';

describe('createFlueClient', () => {
	it('sends sync invocation requests and returns result/runId', async () => {
		const seen: Request[] = [];
		const client = createFlueClient({
			baseUrl: 'https://flue.test',
			fetch: async (input, init) => {
				seen.push(new Request(input, init));
				return Response.json({ result: { ok: true }, _meta: { runId: 'run_1' } });
			},
		});

		await expect(
			client.agents.invoke('hello', 'inst-1', { mode: 'sync', payload: { name: 'Ada' } }),
		).resolves.toEqual({ result: { ok: true }, runId: 'run_1' });
		expect(seen).toHaveLength(1);
		expect(new URL(seen[0]?.url ?? '').pathname).toBe('/agents/hello/inst-1');
		expect(seen[0]?.method).toBe('POST');
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

		await client.admin.runs.list({ status: 'active', agentName: 'hello', limit: 10 });
		const parsed = new URL(url);
		expect(parsed.pathname).toBe('/admin/runs');
		expect(parsed.searchParams.get('status')).toBe('active');
		expect(parsed.searchParams.get('agentName')).toBe('hello');
		expect(parsed.searchParams.get('limit')).toBe('10');
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
