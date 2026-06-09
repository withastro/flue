import { describe, expect, it } from 'vitest';
import {
	type AgentInvokeOptions,
	createFlueClient,
	FlueApiError,
	type ListRunsOptions,
	type RunStatus,
} from '../src/index.ts';

describe('createFlueClient', () => {
	describe('agents.invoke()', () => {
		it('sends agent prompt requests as POST with JSON body', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ result: { ok: true } });
				},
			});

			const options: AgentInvokeOptions = {
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
	});

	describe('agents.stream()', () => {
		it('constructs the correct stream URL from agent name and id', async () => {
			const urls: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input) => {
					urls.push(typeof input === 'string' ? input : new Request(input).url);
					return dsJsonResponse([{ type: 'idle' }]);
				},
			});

			const eventStream = client.agents.stream('my-agent', 'inst-1', {
				offset: '0000000000000042',
				live: false,
			});
			const events = [];
			for await (const event of eventStream) {
				events.push(event);
			}
			expect(events).toEqual([{ type: 'idle' }]);
			expect(urls.length).toBeGreaterThanOrEqual(1);
			const parsed = new URL(urls[0]!);
			expect(parsed.pathname).toBe('/api/agents/my-agent/inst-1');
			expect(parsed.searchParams.get('offset')).toBe('0000000000000042');
		});

		it('passes auth headers to the DS stream via fetch wrapper', async () => {
			const seenHeaders: Record<string, string>[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				token: 'test-token-123',
				headers: { 'x-custom': 'value' },
				fetch: async (input, init) => {
					const h = init?.headers as Record<string, string> | undefined;
					if (h) seenHeaders.push({ ...h });
					return dsJsonResponse([]);
				},
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			// Consume the stream to trigger the fetch.
			for await (const _ of eventStream) {
				// empty
			}
			expect(seenHeaders.length).toBeGreaterThanOrEqual(1);
			expect(seenHeaders[0]).toMatchObject({
				authorization: 'Bearer test-token-123',
				'x-custom': 'value',
			});
		});

		it('cancel() stops iteration and aborts the underlying connection', async () => {
			let fetchCount = 0;
			let lastSignal: AbortSignal | undefined;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (_input, init) => {
					fetchCount++;
					lastSignal = init?.signal as AbortSignal | undefined;
					return dsJsonResponse([{ type: 'agent_start' }]);
				},
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			const events = [];
			for await (const event of eventStream) {
				events.push(event);
				// Cancel after receiving the first event.
				eventStream.cancel();
			}
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: 'agent_start' });
			expect(fetchCount).toBe(1);
			expect(lastSignal?.aborted).toBe(true);
		});
	});

	describe('runs.stream()', () => {
		it('constructs the correct stream URL from run ID', async () => {
			const urls: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					urls.push(typeof input === 'string' ? input : new Request(input).url);
					return dsJsonResponse([{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 100 }], { closed: true });
				},
			});

			const events = [];
			for await (const event of client.runs.stream('run-1', { live: false })) {
				events.push(event);
			}
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: 'run_end' });
			const parsed = new URL(urls[0]!);
			expect(parsed.pathname).toBe('/runs/run-1');
		});
	});

	describe('runs.events()', () => {
		it('returns all run events as an array', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					dsJsonResponse(
						[
							{ type: 'run_start', runId: 'r1' },
							{ type: 'run_end', runId: 'r1', isError: false, durationMs: 50 },
						],
						{ closed: true },
					),
			});

			const events = await client.runs.events('r1');
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({ type: 'run_start' });
			expect(events[1]).toMatchObject({ type: 'run_end' });
		});
	});

	describe('workflows.invoke()', () => {
		it('POSTs to workflow route and returns runId + streamUrl', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ status: 'accepted', runId: 'wf_abc123' }, { status: 202 });
				},
			});

			const result = await client.workflows.invoke('my-workflow', {
				payload: { key: 'value' },
			});
			expect(result.runId).toBe('wf_abc123');
			expect(result.streamUrl).toBe('https://flue.test/runs/wf_abc123');
			expect(seen).toHaveLength(1);
			expect(new URL(seen[0]!.url).pathname).toBe('/workflows/my-workflow');
			expect(seen[0]!.method).toBe('POST');
			expect(await seen[0]!.json()).toEqual({ key: 'value' });
		});

		it('works without a payload', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					Response.json({ status: 'accepted', runId: 'wf_xyz' }, { status: 202 }),
			});

			const result = await client.workflows.invoke('simple-workflow');
			expect(result.runId).toBe('wf_xyz');
			expect(result.streamUrl).toBe('https://flue.test/runs/wf_xyz');
		});
	});

	describe('URL resolution', () => {
		it('resolves public HTTP routes beneath the base URL pathname', async () => {
			const requests: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					if (request.method === 'POST') return Response.json({ result: { ok: true } });
					return Response.json({ runId: 'run-1' });
				},
			});

			await client.agents.invoke('hello', 'inst-1', { payload: { message: 'Hello' } });
			await client.runs.get('run-1');

			expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
				'/api/agents/hello/inst-1',
				'/admin/runs/run-1',
			]);
		});
	});

	describe('error handling', () => {
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
				.invoke('hello', 'inst-1', { payload: { message: 'Hello' } })
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
	});

	describe('admin routes', () => {
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
	});
});

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Build a DS-compliant JSON catch-up response. Used by stream tests to
 * simulate the server without a real DS server.
 */
function dsJsonResponse(
	events: unknown[],
	opts: { closed?: boolean; upToDate?: boolean; nextOffset?: string } = {},
): Response {
	const nextOffset = opts.nextOffset ?? String(events.length).padStart(16, '0');
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'stream-next-offset': nextOffset,
	};
	if (opts.upToDate !== false) {
		headers['stream-up-to-date'] = 'true';
	}
	if (opts.closed) {
		headers['stream-closed'] = 'true';
	}
	return new Response(JSON.stringify(events), { status: 200, headers });
}
