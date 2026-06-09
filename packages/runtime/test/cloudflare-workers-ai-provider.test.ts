import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getCloudflareAIBindingApiProvider } from '../src/cloudflare/workers-ai-provider.ts';
import { resolveModel } from '../src/internal.ts';
import { registerProvider, resetProvidersForTests } from '../src/runtime/providers.ts';

afterEach(() => {
	resetProvidersForTests();
});

async function collectEvents(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function createSseResponse(...chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } },
	);
}

describe('Cloudflare AI binding provider', () => {
	it('returns stream and streamSimple handlers when the provider factory is called', () => {
		const provider = getCloudflareAIBindingApiProvider();

		expect(provider.api).toBe('cloudflare-ai-binding');
		expect(provider.stream).toEqual(expect.any(Function));
		expect(provider.streamSimple).toEqual(expect.any(Function));
	});

	it('invokes the captured AI binding when a Cloudflare model streams a response', async () => {
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
				'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
				'data: [DONE]\n\n',
			),
		);
		registerProvider('cloudflare-captured-binding', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-captured-binding/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().stream(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith(
			'@cf/meta/llama-3.1-8b-instruct',
			{
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			},
			{ returnRawResponse: true },
		);
		expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
	});

	it('forwards gateway options when a provider registration enables AI Gateway', async () => {
		const run = vi.fn(async () =>
			createSseResponse('data: {"choices":[{"finish_reason":"stop"}]}\n\n'),
		);
		registerProvider('cloudflare-gateway', {
			api: 'cloudflare-ai-binding',
			binding: { run },
			gateway: {
				id: 'production-gateway',
				skipCache: true,
				metadata: { tenant: 'acme', attempt: 2 },
			},
		});
		const model = resolveModel('cloudflare-gateway/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(run).toHaveBeenCalledWith(
			'@cf/meta/llama-3.1-8b-instruct',
			{
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			},
			{
				returnRawResponse: true,
				gateway: {
					id: 'production-gateway',
					skipCache: true,
					metadata: { tenant: 'acme', attempt: 2 },
				},
			},
		);
	});

	it('omits gateway options when a provider registration opts out of AI Gateway', async () => {
		const run = vi.fn(async () =>
			createSseResponse('data: {"choices":[{"finish_reason":"stop"}]}\n\n'),
		);
		registerProvider('cloudflare-without-gateway', {
			api: 'cloudflare-ai-binding',
			binding: { run },
			gateway: false,
		});
		const model = resolveModel('cloudflare-without-gateway/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(run).toHaveBeenCalledWith(
			'@cf/meta/llama-3.1-8b-instruct',
			{
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			},
			{ returnRawResponse: true },
		);
	});

	it('forwards session affinity when a model call has a session id', async () => {
		const run = vi.fn(async () =>
			createSseResponse('data: {"choices":[{"finish_reason":"stop"}]}\n\n'),
		);
		registerProvider('cloudflare-session-affinity', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-session-affinity/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(
				model as Model<'cloudflare-ai-binding'>,
				{ messages: [] },
				{ sessionId: 'session-123' },
			),
		);

		expect(run).toHaveBeenCalledWith(
			'@cf/meta/llama-3.1-8b-instruct',
			{
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			},
			{
				returnRawResponse: true,
				extraHeaders: { 'x-session-affinity': 'session-123' },
			},
		);
	});

	it('translates streamed text deltas when the binding returns text SSE events', async () => {
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
				'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
				'data: [DONE]\n\n',
			),
		);
		registerProvider('cloudflare-text-events', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-text-events/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({ type: 'start' }),
			expect.objectContaining({ type: 'text_start', contentIndex: 0 }),
			expect.objectContaining({ type: 'text_delta', contentIndex: 0, delta: 'hello ' }),
			expect.objectContaining({ type: 'text_delta', contentIndex: 0, delta: 'world' }),
			expect.objectContaining({ type: 'text_end', contentIndex: 0, content: 'hello world' }),
			expect.objectContaining({ type: 'done', reason: 'stop' }),
		]);
		expect(events.at(-1)).toMatchObject({
			type: 'done',
			message: { content: [{ type: 'text', text: 'hello world' }] },
		});
	});

	it('translates streamed reasoning deltas when the binding returns reasoning SSE events', async () => {
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n',
				'data: {"choices":[{"delta":{"reasoning_content":"inputs"}}]}\n\n',
				'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
			),
		);
		registerProvider('cloudflare-reasoning-events', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-reasoning-events/@cf/zai-org/glm-4.7-flash');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({ type: 'start' }),
			expect.objectContaining({ type: 'thinking_start', contentIndex: 0 }),
			expect.objectContaining({ type: 'thinking_delta', contentIndex: 0, delta: 'inspect ' }),
			expect.objectContaining({ type: 'thinking_delta', contentIndex: 0, delta: 'inputs' }),
			expect.objectContaining({ type: 'thinking_end', contentIndex: 0, content: 'inspect inputs' }),
			expect.objectContaining({ type: 'done', reason: 'stop' }),
		]);
		expect(events.at(-1)).toMatchObject({
			type: 'done',
			message: {
				content: [
					{ type: 'thinking', thinking: 'inspect inputs', thinkingSignature: 'reasoning_content' },
				],
			},
		});
	});

	it('assembles streamed tool-call arguments when the binding returns tool SSE events', async () => {
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","function":{"name":"weather","arguments":"{\\"city\\":\\"San"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" Francisco\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
			),
		);
		registerProvider('cloudflare-tool-events', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-tool-events/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({ type: 'start' }),
			expect.objectContaining({ type: 'toolcall_start', contentIndex: 0 }),
			expect.objectContaining({ type: 'toolcall_delta', contentIndex: 0, delta: '{"city":"San' }),
			expect.objectContaining({ type: 'toolcall_delta', contentIndex: 0, delta: ' Francisco"}' }),
			expect.objectContaining({
				type: 'toolcall_end',
				contentIndex: 0,
				toolCall: {
					type: 'toolCall',
					id: 'call_weather',
					name: 'weather',
					arguments: { city: 'San Francisco' },
				},
			}),
			expect.objectContaining({ type: 'done', reason: 'toolUse' }),
		]);
	});

	it('reports streamed token usage including cached prompt tokens when the binding returns usage SSE events', async () => {
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
				'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
			),
		);
		registerProvider('cloudflare-usage-events', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-usage-events/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events.at(-1)).toMatchObject({
			type: 'done',
			message: {
				usage: {
					input: 7,
					output: 4,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	});

	it('maps unsupported finish reasons to provider errors when the binding reports an unknown reason', async () => {
		const run = vi.fn(async () =>
			createSseResponse('data: {"choices":[{"finish_reason":"future_reason"}]}\n\n'),
		);
		registerProvider('cloudflare-unknown-finish-reason', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-unknown-finish-reason/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({ type: 'start' }),
			expect.objectContaining({
				type: 'error',
				reason: 'error',
				error: expect.objectContaining({
					stopReason: 'error',
					errorMessage: 'Provider finish_reason: future_reason',
				}),
			}),
		]);
	});

	it('surfaces an aborted stream when the model call signal is aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const run = vi.fn(async () =>
			createSseResponse(
				'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
				'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
			),
		);
		registerProvider('cloudflare-aborted-stream', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-aborted-stream/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(
				model as Model<'cloudflare-ai-binding'>,
				{ messages: [] },
				{ signal: controller.signal },
			),
		);

		expect(run).toHaveBeenCalledWith(
			'@cf/meta/llama-3.1-8b-instruct',
			{
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			},
			{ returnRawResponse: true, signal: controller.signal },
		);
		expect(events.at(-1)).toMatchObject({
			type: 'error',
			reason: 'aborted',
			error: { stopReason: 'aborted', errorMessage: 'Request was aborted' },
		});
	});

	it('surfaces a provider error when the AI binding returns a non-success response', async () => {
		const run = vi.fn(
			async () => new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' }),
		);
		registerProvider('cloudflare-provider-error', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-provider-error/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				type: 'error',
				reason: 'error',
				error: expect.objectContaining({
					stopReason: 'error',
					errorMessage: 'Cloudflare AI binding returned 429 Too Many Requests: quota exceeded',
				}),
			}),
		]);
	});

	it('surfaces a provider error when the AI binding returns no stream body', async () => {
		const run = vi.fn(async () => new Response(null));
		registerProvider('cloudflare-empty-body', {
			api: 'cloudflare-ai-binding',
			binding: { run },
		});
		const model = resolveModel('cloudflare-empty-body/@cf/meta/llama-3.1-8b-instruct');
		expect(model).toBeDefined();
		if (!model) throw new Error('Expected a resolved Workers AI model.');

		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(model as Model<'cloudflare-ai-binding'>, {
				messages: [],
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				type: 'error',
				reason: 'error',
				error: expect.objectContaining({
					stopReason: 'error',
					errorMessage: 'Cloudflare AI binding returned empty response body.',
				}),
			}),
		]);
	});

	it('rejects a binding-backed model when no usable AI binding is attached', async () => {
		const events = await collectEvents(
			getCloudflareAIBindingApiProvider().streamSimple(
				{
					id: '@cf/meta/llama-3.1-8b-instruct',
					name: '@cf/meta/llama-3.1-8b-instruct',
					api: 'cloudflare-ai-binding',
					provider: 'cloudflare',
					baseUrl: '',
					reasoning: false,
					input: ['text'],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 0,
					maxTokens: 0,
				} satisfies Model<'cloudflare-ai-binding'>,
				{ messages: [] },
			),
		);

		expect(events).toEqual([
			expect.objectContaining({
				type: 'error',
				reason: 'error',
				error: expect.objectContaining({
					stopReason: 'error',
					errorMessage: expect.stringContaining('[flue] Cloudflare AI binding not available.'),
				}),
			}),
		]);
	});
});
