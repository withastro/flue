import { describe, expect, it } from 'vitest';
import {
	type ConversationStreamChunk,
	createFlueClient,
	FlueApiError,
} from '../src/index.ts';

describe('createFlueClient', () => {
	describe('default global fetch', () => {
		it('calls the global fetch with the correct receiver in a browser-like global', async () => {
			// Regression for "Illegal invocation" in browsers: when no custom fetch
			// is supplied, the SDK must invoke the global `fetch` with `globalThis`
			// as its receiver, not the HttpClient instance.
			const original = globalThis.fetch;
			let calledWithCorrectReceiver = false;
			globalThis.fetch = function (this: unknown) {
				if (this !== globalThis) {
					throw new TypeError("Failed to execute 'fetch': Illegal invocation");
				}
				calledWithCorrectReceiver = true;
				return Promise.resolve(
					Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1', submissionId: 's1' }),
				);
			} as typeof fetch;
			try {
				const client = createFlueClient({ baseUrl: 'https://flue.test' });
				await expect(
					client.agents.send('hello', 'inst-1', { message: { kind: 'user', body: 'hi' } }),
				).resolves.toEqual({ streamUrl: 'https://flue.test/stream', offset: '-1', submissionId: 's1' });
				expect(calledWithCorrectReceiver).toBe(true);
			} finally {
				globalThis.fetch = original;
			}
		});
	});

	describe('agents.send()', () => {
		it('sends the DeliveredMessage as the wire body', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1' });
				},
			});
			await client.agents.send('hello', 'inst-1', {
				message: {
					kind: 'user',
					body: 'Hello',
					attachments: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
				},
			});
			expect(await seen[0]?.json()).toEqual({
				kind: 'user',
				body: 'Hello',
				attachments: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			});
		});

		it('threads a client-supplied submissionId as a sibling of the message fields', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1' });
				},
			});
			await client.agents.send('hello', 'inst-1', {
				message: { kind: 'user', body: 'Hello' },
				submissionId: 'send-1',
			});
			expect(await seen[0]?.json()).toEqual({
				kind: 'user',
				body: 'Hello',
				submissionId: 'send-1',
			});
		});
	});

	describe('agents.history() attachment urls', () => {
		it('resolves a url on durably-recorded file parts and leaves preview parts untouched', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					Response.json({
						v: 1,
						conversationId: 'c1',
						offset: '0000000000000000_0000000000000001',
						messages: [
							{
								id: 'u1',
								role: 'user',
								parts: [
									{ type: 'file', mediaType: 'image/png', id: 'att-1', size: 3 },
									{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
								],
							},
						],
						settlements: [],
					}),
			});

			const snapshot = await client.agents.history('agent', 'inst-1');
			const parts = snapshot.messages[0]?.parts as Array<{ url?: string }>;
			expect(parts[0]?.url).toBe('https://flue.test/agents/agent/inst-1/attachments/att-1');
			// A part that already carries a url (e.g. an optimistic data URL) is left as-is.
			expect(parts[1]?.url).toBe('data:image/png;base64,AAAA');
		});
	});

	describe('agents.observe()', () => {
		it('materializes history before following updates from the snapshot offset', async () => {
			const seen: string[] = [];
			let resolveFollowed!: () => void;
			const followed = new Promise<void>((resolve) => {
				resolveFollowed = resolve;
			});
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					seen.push(`${url.searchParams.get('view')}:${url.searchParams.get('offset') ?? ''}`);
					if (url.searchParams.get('view') === 'history') {
						return Response.json({
							v: 1,
							conversationId: 'conversation-1',
							offset: '0000000000000000_0000000000000001',
							messages: [{ id: 'entry-user', role: 'user', parts: [{ type: 'text', text: 'hello', state: 'done' }] }],
							settlements: [],
						});
					}
					resolveFollowed();
					return dsJsonResponse([], {
						nextOffset: '0000000000000000_0000000000000001',
						upToDate: true,
						closed: true,
					});
				},
			});
			const observation = client.agents.observe('agent', 'id');
			observation.subscribe(() => {});
			await followed;

			expect(observation.getSnapshot()).toMatchObject({
				offset: '0000000000000000_0000000000000001',
				conversation: { conversationId: 'conversation-1', messages: [{ id: 'entry-user' }] },
			});
			expect(seen).toEqual(['history:', 'updates:0000000000000000_0000000000000001']);
			observation.close();
		});

		it('reports an absent conversation and rehydrates after refresh', async () => {
			let historyCalls = 0;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('view') === 'history') {
						historyCalls++;
						if (historyCalls === 1) return Response.json({ error: { message: 'missing' } }, { status: 404 });
						return Response.json({
							v: 1,
							conversationId: 'conversation-1',
							offset: '0000000000000000_0000000000000001',
							messages: [],
							settlements: [],
						});
					}
					return dsJsonResponse([], {
						nextOffset: '0000000000000000_0000000000000001',
						upToDate: true,
						closed: true,
					});
				},
			});
			const observation = client.agents.observe('agent', 'id');
			const absent = new Promise<void>((resolve) => {
				const unsubscribe = observation.subscribe(() => {
					if (observation.getSnapshot().phase === 'absent') {
						unsubscribe();
						resolve();
					}
				});
			});
			await absent;

			const rehydrated = new Promise<void>((resolve) => {
				const unsubscribe = observation.subscribe(() => {
					if (observation.getSnapshot().conversation) {
						unsubscribe();
						resolve();
					}
				});
			});
			observation.refresh();
			await rehydrated;

			expect(observation.getSnapshot().conversation).toMatchObject({
				conversationId: 'conversation-1',
			});
			observation.close();
		});

		it('applies fan-out chunks and dedupes a redelivered batch by position', async () => {
			// started + two same-batch deltas (distinct index) + a later delta.
			const original: ConversationStreamChunk[] = [
				{ type: 'message-started', conversationId: 'c1', messageId: 'a1', position: { batch: 1, index: 0 } },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hel', position: { batch: 2, index: 0 } },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'lo', position: { batch: 2, index: 1 } },
			];
			let updatesCalls = 0;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('view') === 'history') {
						return Response.json({ v: 1, conversationId: 'c1', offset: '0', messages: [], settlements: [] });
					}
					updatesCalls++;
					if (updatesCalls === 1) {
						return dsJsonResponse(original, { upToDate: false, nextOffset: '2' });
					}
					// Redelivery of the whole batch (as an SSE reconnect would replay)
					// plus one genuinely new delta. The replayed chunks must be skipped.
					return dsJsonResponse(
						[
							...original,
							{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: '!', position: { batch: 3, index: 0 } },
						] satisfies ConversationStreamChunk[],
						{ closed: true, nextOffset: '3' },
					);
				},
			});

			const observation = client.agents.observe('agent', 'id');
			const settled = new Promise<void>((resolve) => {
				observation.subscribe(() => {
					const text = assistantText(observation.getSnapshot().conversation);
					if (text.endsWith('!')) resolve();
				});
			});
			await settled;

			expect(assistantText(observation.getSnapshot().conversation)).toBe('hello!');
			observation.close();
		});
	});

	describe('agents.history()', () => {
		it('reads one materialized snapshot via the history view', async () => {
			let seen = '';
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api',
				fetch: async (input) => {
					seen = typeof input === 'string' ? input : new Request(input).url;
					return Response.json({
						v: 1,
						conversationId: 'conversation-1',
						offset: 'offset-1',
						messages: [],
						settlements: [],
					});
				},
			});

			await client.agents.history('agent', 'id');

			const url = new URL(seen);
			expect(url.searchParams.get('view')).toBe('history');
			expect(url.searchParams.has('harness')).toBe(false);
			expect(url.searchParams.has('session')).toBe(false);
			expect(url.searchParams.has('tail')).toBe(false);
		});
	});

	describe('runs.stream()', () => {
		it('constructs the correct stream URL from run ID', async () => {
			const urls: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					urls.push(typeof input === 'string' ? input : new Request(input).url);
					return dsJsonResponse(
						[{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 100 }],
						{ closed: true },
					);
				},
			});

			const events = [];
			for await (const event of client.runs.stream('run-1', { live: false })) {
				events.push(event);
			}
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: 'run_end' });
			const [url] = urls;
			if (!url) throw new Error('Expected a stream request URL.');
			const parsed = new URL(url);
			expect(parsed.pathname).toBe('/runs/run-1');
		});

		it('yields the full history with live:false when the server splits catch-up into multiple batches', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('offset') === '-1') {
						// Server caps the batch and omits Stream-Up-To-Date.
						return dsJsonResponse(
							[
								{ type: 'run_start', runId: 'run-1' },
								{ type: 'turn_start', runId: 'run-1' },
							],
							{ upToDate: false, nextOffset: '0000000000000000_0000000000000002' },
						);
					}
					return dsJsonResponse(
						[{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 50 }],
						{
							closed: true,
							nextOffset: '0000000000000000_0000000000000003',
						},
					);
				},
			});

			const events = [];
			for await (const event of client.runs.stream('run-1', { live: false })) {
				events.push(event);
			}
			expect(events).toHaveLength(3);
			expect(events[2]).toMatchObject({ type: 'run_end' });
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

		it('preserves tail across catch-up reads', async () => {
			const urls: URL[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					urls.push(url);
					if (url.searchParams.get('offset') === '-1') {
						return dsJsonResponse([{ type: 'run_start', runId: 'r1' }], {
							upToDate: false,
							nextOffset: '0000000000000000_0000000000000001',
						});
					}
					return dsJsonResponse([], { closed: true });
				},
			});

			await client.runs.events('r1', { tail: 25 });

			expect(urls.map((url) => url.searchParams.get('tail'))).toEqual(['25', '25']);
			expect(urls.map((url) => url.searchParams.get('offset'))).toEqual([
				'-1',
				'0000000000000000_0000000000000001',
			]);
		});

		it('returns the full history when the server splits catch-up into multiple batches', async () => {
			const offsets: Array<string | null> = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					const offset = url.searchParams.get('offset');
					offsets.push(offset);
					if (offset === '-1') {
						// Server caps the batch and omits Stream-Up-To-Date.
						return dsJsonResponse(
							[
								{ type: 'run_start', runId: 'r1' },
								{ type: 'turn_start', runId: 'r1' },
							],
							{ upToDate: false, nextOffset: '0000000000000000_0000000000000002' },
						);
					}
					return dsJsonResponse(
						[{ type: 'run_end', runId: 'r1', isError: false, durationMs: 50 }],
						{
							closed: true,
							nextOffset: '0000000000000000_0000000000000003',
						},
					);
				},
			});

			const events = await client.runs.events('r1');
			expect(events).toHaveLength(3);
			expect(events[2]).toMatchObject({ type: 'run_end' });
			expect(offsets).toEqual(['-1', '0000000000000000_0000000000000002']);
		});
	});

	describe('workflows.invoke()', () => {
		it('POSTs to workflow route and returns the run ID', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ runId: 'run_abc123' }, { status: 202 });
				},
			});

			const result = await client.workflows.invoke('my-workflow', {
				input: { key: 'value' },
			});
			expect(result).toEqual({ runId: 'run_abc123' });
			expect(seen).toHaveLength(1);
			const [request] = seen;
			if (!request) throw new Error('Expected a workflow request.');
			const url = new URL(request.url);
			expect(url.pathname).toBe('/workflows/my-workflow');
			expect(url.searchParams.has('wait')).toBe(false);
			expect(request.method).toBe('POST');
			expect(await request.json()).toEqual({ key: 'value' });
		});

		it('requests ?wait=result and returns the terminal result when wait is "result"', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({
						result: { summary: 'done' },
						runId: 'run_abc123',
					});
				},
			});

			const result = await client.workflows.invoke('my-workflow', {
				input: { key: 'value' },
				wait: 'result',
			});
			expect(result).toEqual({
				result: { summary: 'done' },
				runId: 'run_abc123',
			});
			expect(seen).toHaveLength(1);
			const [request] = seen;
			if (!request) throw new Error('Expected a workflow request.');
			const url = new URL(request.url);
			expect(url.pathname).toBe('/workflows/my-workflow');
			expect(url.searchParams.get('wait')).toBe('result');
			expect(await request.json()).toEqual({ key: 'value' });
		});

		it('invokes the workflow with an omitted HTTP body when no input is provided', async () => {
			let request: Request | undefined;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					request = new Request(input, init);
					return Response.json({ runId: 'run_xyz' }, { status: 202 });
				},
			});

			const result = await client.workflows.invoke('simple-workflow');
			expect(result).toEqual({ runId: 'run_xyz' });
			expect(request?.headers.has('content-type')).toBe(false);
			expect(await request?.text()).toBe('');
		});
	});

	describe('agents.wait()', () => {
		it('follows an admission from its offset and resolves on its settlement chunk', async () => {
			const offsets: Array<string | null> = [];
			const seenEvents: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					offsets.push(url.searchParams.get('offset'));
					return dsJsonResponse(
						[
							{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hello', position: { batch: 1, index: 0 } },
							{ type: 'submission-settled', conversationId: 'c1', submissionId: 'other', outcome: 'completed', position: { batch: 2, index: 0 } },
							{ type: 'submission-settled', conversationId: 'c1', submissionId: 'submission-1', outcome: 'completed', position: { batch: 3, index: 0 } },
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					);
				},
			});

			await expect(
				client.agents.wait(
					{
						streamUrl: 'https://flue.test/agents/hello/instance-1',
						offset: 'admission-offset',
						submissionId: 'submission-1',
					},
					{ onEvent: (event) => seenEvents.push(event.type) },
				),
			).resolves.toBeUndefined();
			expect(offsets).toEqual(['admission-offset']);
			expect(seenEvents).toEqual(['message-delta', 'submission-settled', 'submission-settled']);
		});

		it('throws a structured SDK error when the submission fails', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					dsJsonResponse(
						[
							{
								type: 'submission-settled',
								conversationId: 'c1',
								submissionId: 'submission-1',
								outcome: 'failed',
								error: { name: 'Error', message: 'model unavailable' },
								position: { batch: 1, index: 0 },
							},
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					),
			});

			const error = await client.agents
				.wait({
					streamUrl: 'https://flue.test/agents/hello/instance-1',
					offset: 'admission-offset',
					submissionId: 'submission-1',
				})
				.catch((error: unknown) => error);

			expect(error).toMatchObject({
				name: 'FlueExecutionError',
				target: 'agent_submission',
				targetId: 'submission-1',
				failure: 'failed',
				error: { name: 'Error', message: 'model unavailable' },
			});
		});

		it('classifies an aborted settlement distinctly from a failure', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					dsJsonResponse(
						[
							{
								type: 'submission-settled',
								conversationId: 'c1',
								submissionId: 'submission-1',
								outcome: 'aborted',
								error: { name: 'SubmissionAbortedError', message: 'Submission was aborted.' },
								position: { batch: 1, index: 0 },
							},
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					),
			});

			const error = await client.agents
				.wait({
					streamUrl: 'https://flue.test/agents/hello/instance-1',
					offset: 'admission-offset',
					submissionId: 'submission-1',
				})
				.catch((error: unknown) => error);

			expect(error).toMatchObject({
				name: 'FlueExecutionError',
				target: 'agent_submission',
				targetId: 'submission-1',
				failure: 'aborted',
			});
			expect((error as Error).message).toContain('was aborted');
		});
	});

	describe('workflows.run()', () => {
		it('invokes a workflow, delivers events, and returns the run_end result', async () => {
			const requests: Request[] = [];
			const seenEvents: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					if (request.method === 'POST') return Response.json({ runId: 'run-1' }, { status: 202 });
					return dsJsonResponse(
						[
							{ type: 'run_start', runId: 'run-1' },
							{ type: 'run_end', runId: 'run-1', isError: false, result: 42, durationMs: 10 },
						],
						{ closed: true },
					);
				},
			});

			await expect(
				client.workflows.run<number>('report', {
					input: { month: 'June' },
					onEvent: (event) => seenEvents.push(event.type),
				}),
			).resolves.toEqual({ runId: 'run-1', result: 42 });
			expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
				'/workflows/report',
				'/runs/run-1',
			]);
			expect(seenEvents).toEqual(['run_start', 'run_end']);
		});

		it('falls back to run metadata when the stream ends without run_end', async () => {
			const paths: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					const request = new Request(input, init);
					const url = new URL(request.url);
					paths.push(`${url.pathname}${url.search}`);
					if (request.method === 'POST') return Response.json({ runId: 'run-1' }, { status: 202 });
					if (url.searchParams.has('meta')) {
						return Response.json({
							runId: 'run-1',
							workflowName: 'report',
							status: 'completed',
							startedAt: '2026-06-01T00:00:00.000Z',
							result: { summary: 'done' },
						});
					}
					return dsJsonResponse([{ type: 'run_start', runId: 'run-1' }], { closed: true });
				},
			});

			await expect(client.workflows.run('report')).resolves.toEqual({
				runId: 'run-1',
				result: { summary: 'done' },
			});
			expect(paths).toEqual(['/workflows/report', '/runs/run-1?offset=-1', '/runs/run-1?meta']);
		});
	});

	describe('URL resolution', () => {
		it('resolves relative base URLs against the browser origin', async () => {
			const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
			Object.defineProperty(globalThis, 'location', {
				configurable: true,
				value: { origin: 'https://app.test' },
			});
			try {
				let url = '';
				const client = createFlueClient({
					baseUrl: '/api',
					fetch: async (input) => {
						url = typeof input === 'string' ? input : new Request(input).url;
						return Response.json({ runId: 'run-1' });
					},
				});
				await client.runs.get('run-1');
				expect(url).toBe('https://app.test/api/runs/run-1?meta');
			} finally {
				if (original) Object.defineProperty(globalThis, 'location', original);
				else Reflect.deleteProperty(globalThis, 'location');
			}
		});

		it('rejects relative base URLs outside a browser', () => {
			expect(() => createFlueClient({ baseUrl: '/api' })).toThrow(
				'relative baseUrl requires a browser; pass an absolute URL',
			);
		});

		it('resolves public HTTP routes beneath the base URL pathname', async () => {
			const requests: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					if (request.method === 'POST')
						return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1', submissionId: 's1' });
					return Response.json({ runId: 'run-1' });
				},
			});

			await client.agents.send('hello', 'inst-1', { message: { kind: 'user', body: 'Hello' } });
			await client.runs.get('run-1');

			expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
				'/api/agents/hello/inst-1',
				'/api/runs/run-1',
			]);
		});
	});

	describe('runs.get()', () => {
		it('requests the public ?meta view of the run route', async () => {
			let url = '';
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input, init) => {
					url = new Request(input, init).url;
					return Response.json({
						runId: 'run-1',
						workflowName: 'daily-report',
						status: 'completed',
						startedAt: '2026-06-01T10:00:00.000Z',
					});
				},
			});

			await expect(client.runs.get('run-1')).resolves.toMatchObject({
				runId: 'run-1',
				workflowName: 'daily-report',
			});
			const parsed = new URL(url);
			expect(parsed.pathname).toBe('/api/runs/run-1');
			expect(parsed.searchParams.has('meta')).toBe(true);
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
				.send('hello', 'inst-1', { message: 'Hello' })
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
});

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Build a DS-compliant JSON catch-up response. Used by stream tests to
 * simulate the server without a real DS server.
 */
function assistantText(conversation: { messages: Array<{ id: string; parts: unknown[] }> } | undefined): string {
	const message = conversation?.messages.find((entry) => entry.id === 'a1');
	if (!message) return '';
	return message.parts
		.filter((part): part is { type: string; text: string } =>
			typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
		)
		.map((part) => part.text)
		.join('');
}

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
	return new Response(
		JSON.stringify(
			events.map((event) =>
				event && typeof event === 'object' && !('v' in event) ? { ...event, v: 3 } : event,
			),
		),
		{ status: 200, headers },
	);
}
