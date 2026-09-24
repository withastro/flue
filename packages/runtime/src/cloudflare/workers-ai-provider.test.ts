import { normalizeContext } from '@earendil-works/pi-ai';
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
