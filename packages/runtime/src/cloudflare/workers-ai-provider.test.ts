import { normalizeContext, type TranscriptContext } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { cloudflareBindingProvider } from './workers-ai-provider.ts';

function sseResponse(chunks: unknown[]): Response {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A minimal valid Anthropic Messages SSE stream, with `event:` names. */
function anthropicSseResponse(): Response {
	const events = [
		[
			'message_start',
			{
				type: 'message_start',
				message: { id: 'msg_1', usage: { input_tokens: 1, output_tokens: 0 } },
			},
		],
		[
			'content_block_start',
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		],
		[
			'content_block_delta',
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
		],
		['content_block_stop', { type: 'content_block_stop', index: 0 }],
		[
			'message_delta',
			{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
		],
		['message_stop', { type: 'message_stop' }],
	] as const;
	const body = events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join('');
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function anthropicProviderFor(extra?: Partial<Parameters<typeof cloudflareBindingProvider>[0]>) {
	let recorded: Record<string, unknown> | undefined;
	const binding = {
		async run(_modelId: string, params: Record<string, unknown>) {
			recorded = params;
			return anthropicSseResponse();
		},
	};
	const provider = cloudflareBindingProvider({
		binding: binding as never,
		gateway: false,
		...(extra ?? {}),
	});
	const model = provider
		.getModels()
		.find((candidate) => candidate.id === 'anthropic/claude-opus-5');
	if (!model) throw new Error('Expected an anthropic gateway catalog model');
	return { provider, model, recorded: () => recorded };
}

function providerFor(chunks: unknown[]) {
	const binding = {
		async run() {
			return sseResponse(chunks);
		},
	};
	const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
	const model = provider.getModels().find((candidate) => candidate.id.startsWith('@cf/'));
	if (!model) throw new Error('Expected a Workers AI catalog model');
	return { provider, model };
}

describe('Cloudflare Workers AI assistant content', () => {
	it.each([
		['null', { role: 'assistant', content: null }],
		['omitted', { role: 'assistant' }],
	])('treats %s content as no text and continues processing tool calls', async (_name, delta) => {
		const { provider, model } = providerFor([
			{ choices: [{ delta }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: 'call_1',
									function: { name: 'lookup', arguments: '{}' },
								},
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
		]);

		const result = await provider.streamSimple(model, normalizeContext({ messages: [] })).result();

		expect(result.stopReason).toBe('toolUse');
		expect(result.content).toEqual([
			{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: {} },
		]);
	});

	it.each([
		['an object', { unexpected: true }],
		['an array', ['unexpected']],
	])('rejects content containing %s', async (description, content) => {
		const { provider, model } = providerFor([
			{ choices: [{ delta: { role: 'assistant', content } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
		]);

		const result = await provider.streamSimple(model, normalizeContext({ messages: [] })).result();

		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toContain(
			`invalid choices[0].delta.content: expected a string, null, or an omitted field; received ${description}`,
		);
	});
});

describe('Cloudflare binding Anthropic gateway effort', () => {
	it('maps the thinking level to output_config.effort for adaptive-thinking models', async () => {
		const { provider, model, recorded } = anthropicProviderFor();
		const result = await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'x',
					messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
					tools: [],
				}),
				{ reasoning: 'low' },
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
		expect(recorded()).toMatchObject({
			thinking: { type: 'adaptive', display: 'summarized' },
			output_config: { effort: 'low' },
		});
	});

	it('maps xhigh through the model thinkingLevelMap', async () => {
		const { provider, model, recorded } = anthropicProviderFor();
		const result = await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'x',
					messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
					tools: [],
				}),
				{ reasoning: 'xhigh' },
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(recorded()).toMatchObject({ output_config: { effort: 'xhigh' } });
	});

	it('omits output_config when reasoning is not set', async () => {
		const { provider, model, recorded } = anthropicProviderFor();
		const result = await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'x',
					messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
					tools: [],
				}),
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(recorded()?.output_config).toBeUndefined();
	});
});

describe('Cloudflare binding Anthropic prompt caching', () => {
	it('defaults to cacheRetention none — no cache_control markers', async () => {
		const { provider, model, recorded } = anthropicProviderFor();
		await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'x',
					messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
					tools: [],
				}),
				{ sessionId: 'session-1' },
			)
			.result();
		expect(JSON.stringify(recorded())).not.toContain('cache_control');
	});

	it('cacheRetention short emits cache_control on messages and tools', async () => {
		const { provider, model, recorded } = anthropicProviderFor({ cacheRetention: 'short' });
		await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'x',
					messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
					tools: [],
				}),
				{ sessionId: 'session-1' },
			)
			.result();
		const payload = JSON.stringify(recorded());
		expect(payload).toContain('cache_control');
		expect(payload).toContain('"type":"ephemeral"');
	});
});

// ─── Behavioral probes: the transcript-adaptation behavior this PR changes ──

function recordingProvider(chunks: unknown[]): {
	provider: ReturnType<typeof cloudflareBindingProvider>;
	recorded: () => Record<string, unknown> | undefined;
} {
	let recorded: Record<string, unknown> | undefined;
	const binding = {
		async run(_modelId: string, params: Record<string, unknown>) {
			recorded = params;
			return sseResponse(chunks);
		},
	};
	const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
	return { provider, recorded: () => recorded };
}

/** Minimal valid OpenAI Responses SSE (message with one output_text part). */
function responsesSseResponse(text = 'hi'): Response {
	const events = [
		{ type: 'response.created', response: { id: 'resp_1' } },
		{
			type: 'response.output_item.added',
			output_index: 0,
			item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
		},
		{
			type: 'response.content_part.added',
			item_id: 'msg_1',
			output_index: 0,
			content_index: 0,
			part: { type: 'output_text', text: '' },
		},
		{
			type: 'response.output_text.delta',
			item_id: 'msg_1',
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: 'response.output_text.done',
			item_id: 'msg_1',
			output_index: 0,
			content_index: 0,
			text,
		},
		{
			type: 'response.content_part.done',
			item_id: 'msg_1',
			output_index: 0,
			content_index: 0,
			part: { type: 'output_text', text },
		},
		{
			type: 'response.output_item.done',
			output_index: 0,
			item: {
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text }],
			},
		},
		{ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
	] as const;
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const functionTool = (name: string) => ({
	name,
	label: name,
	description: `Does ${name} things.`,
	parameters: { type: 'object' as const, properties: {} },
});

const completionsModel = (compat?: Record<string, unknown>, reasoning = false) => ({
	id: '@cf/test/model',
	name: 'Test Model',
	api: 'openai-completions' as const,
	provider: 'cloudflare',
	baseUrl: '',
	reasoning,
	input: ['text' as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
	compat,
});

describe('Cloudflare binding transcript adaptation', () => {
	it('carries request-level tools and the system prompt on the chat-completions branch', async () => {
		const { provider, recorded } = recordingProvider([
			{ choices: [{ delta: { content: 'ok' } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
		]);
		const result = await provider
			.stream(
				completionsModel(),
				normalizeContext({
					systemPrompt: 'System instructions.',
					messages: [],
					tools: [functionTool('lookup')],
				}),
			)
			.result();
		expect(result.errorMessage).toBeUndefined();
		const payload = recorded();
		expect(payload).toBeDefined();
		const tools = (payload as Record<string, unknown>).tools as Array<{
			function?: { name?: string; description?: string };
		}>;
		expect(tools.map((tool) => tool.function?.name)).toContain('lookup');
		expect(tools[0]?.function?.description).toContain('Does lookup things.');
		const messages = (payload as Record<string, unknown>).messages as Array<{
			role?: string;
			content?: unknown;
		}>;
		expect(messages[0]?.role).toBe('system');
		expect(JSON.stringify(messages[0])).toContain('System instructions.');
	});

	it('merges per-model catalog compat overrides over the base Workers AI profile', async () => {
		const { provider, recorded } = recordingProvider([
			{ choices: [{ delta: { content: 'ok' } }] },
			{ choices: [{ delta: {}, finish_reason: 'stop' }] },
		]);
		// `supportsDeveloperRole` is false in the hardcoded base profile; a
		// catalog override must win and switch the instruction role.
		await provider
			.stream(
				completionsModel({ supportsDeveloperRole: true, supportsReasoningEffort: true }, true),
				normalizeContext({ systemPrompt: 'System instructions.', messages: [] }),
			)
			.result();
		const messages = recorded()?.messages as Array<{ role?: string }>;
		expect(messages[0]?.role).toBe('developer');
	});

	it('carries request-level tools and the system prompt on the Responses branch', async () => {
		let recorded: Record<string, unknown> | undefined;
		const binding = {
			async run(_modelId: string, params: Record<string, unknown>) {
				recorded = params;
				return responsesSseResponse();
			},
		};
		const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
		const model = {
			id: 'openai/test-model',
			name: 'Test Model',
			api: 'openai-responses' as const,
			provider: 'cloudflare',
			baseUrl: '',
			reasoning: false,
			input: ['text' as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
		};
		const result = await provider
			.stream(
				model,
				normalizeContext({
					systemPrompt: 'System instructions.',
					messages: [],
					tools: [functionTool('lookup')],
				}),
			)
			.result();
		expect(result.errorMessage).toBeUndefined();
		const tools = recorded?.tools as Array<{ name?: string; description?: string }> | undefined;
		expect(tools?.map((tool) => tool.name)).toContain('lookup');
		expect(JSON.stringify(recorded?.input)).toContain('System instructions.');
	});

	it('renders mid-conversation tool additions as additional_tools on the Responses branch', async () => {
		let recorded: Record<string, unknown> | undefined;
		const binding = {
			async run(_modelId: string, params: Record<string, unknown>) {
				recorded = params;
				return responsesSseResponse();
			},
		};
		const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
		const model = {
			id: 'openai/test-model',
			name: 'Test Model',
			api: 'openai-responses' as const,
			provider: 'cloudflare',
			baseUrl: '',
			reasoning: false,
			input: ['text' as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
			compat: {
				supportsMidConvoSystemMessages: true,
				supportsAdditionalTools: true,
				supportsToolSearch: false,
			},
		};
		// Tool `a` is declared in the leading system message; tool `b` is added
		// mid-conversation by a later system message — the deferred-loading
		// channel (`additional_tools`) is the model's own, so `b` must not be
		// in the request-level tools and must appear as an anchored item.
		// `normalizeContext` cannot produce a mid-conversation `toolsAdded`
		// message, so the transcript is built by hand.
		const transcript = {
			messages: [
				{
					role: 'system' as const,
					content: 'System instructions.',
					toolsAdded: [functionTool('a')],
					timestamp: 0,
				},
				{
					role: 'system' as const,
					content: 'New tool.',
					toolsAdded: [functionTool('b')],
					timestamp: 1,
				},
				{ role: 'user' as const, content: 'hi', timestamp: 2 },
			],
		} as TranscriptContext;
		await provider.stream(model, transcript).result();
		const tools = (recorded?.tools ?? []) as Array<{ name?: string }>;
		expect(tools.map((tool) => tool.name)).toEqual(['a']);
		expect(JSON.stringify(recorded?.input)).toContain('"type":"additional_tools"');
		expect(JSON.stringify(recorded?.input)).toContain('"b"');
	});

	it('maps the thinking level into the Responses reasoning field', async () => {
		let recorded: Record<string, unknown> | undefined;
		const binding = {
			async run(_modelId: string, params: Record<string, unknown>) {
				recorded = params;
				return responsesSseResponse();
			},
		};
		const provider = cloudflareBindingProvider({ binding: binding as never, gateway: false });
		const model = {
			id: 'openai/test-model',
			name: 'Test Model',
			api: 'openai-responses' as const,
			provider: 'cloudflare',
			baseUrl: '',
			reasoning: true,
			input: ['text' as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
			thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
		};
		await provider
			.streamSimple(model, normalizeContext({ messages: [] }), { reasoning: 'high' })
			.result();
		expect(recorded?.reasoning).toEqual({ effort: 'high', summary: 'auto' });
	});
});
