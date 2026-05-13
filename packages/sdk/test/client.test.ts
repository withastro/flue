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
});
