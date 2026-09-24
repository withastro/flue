import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { describe, expect, it } from 'vitest';
import {
	documentOmittedPlaceholder,
	mergeOperationAttachments,
	prepareDocumentRequest,
	toPublicAttachment,
} from './document-attachments.ts';
import { init, useModel } from './index.ts';
import { sqlite, start } from './node/index.ts';
import { parseDeliveredMessage } from './runtime/schemas.ts';

const PDF = 'JVBERi0xLjQK';
const PNG = 'iVBORw0KGgo=';

function model(api: string, provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: 'http://127.0.0.1:1',
		reasoning: false,
		input: ['text', 'image'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	} as Model<Api>;
}

function documentContext(): Context {
	return {
		systemPrompt: 'system',
		messages: [
			{
				role: 'user',
				timestamp: 0,
				content: [
					{ type: 'text', text: 'Summarize this quote.' },
					{ type: 'image', data: PNG, mimeType: 'image/png' },
					{
						type: 'image',
						data: PDF,
						mimeType: 'application/pdf',
						filename: 'quote.pdf',
					} as never,
				],
			},
		],
	};
}

class PayloadCaptured extends Error {}

/**
 * Drive a real pi-ai API implementation up to the point where it would send
 * the request, and return the provider payload after Flue's rewrite. Pins the
 * pi payload shapes the rewrite depends on: a pi bump that changes them fails
 * here instead of silently sending image-typed PDFs.
 */
async function capturePayload(
	api: { stream: (m: Model<Api>, c: Context, o?: SimpleStreamOptions) => AsyncIterable<unknown> },
	target: Model<Api>,
	context: Context,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const prepared = prepareDocumentRequest(target, context, {
		apiKey: 'test-key',
		onPayload: (payload) => {
			captured = payload as Record<string, unknown>;
			throw new PayloadCaptured();
		},
	});
	for await (const event of api.stream(target, prepared.context, prepared.options)) {
		if ((event as { type?: string }).type === 'error') break;
	}
	if (!captured) throw new Error('provider payload was not captured');
	return captured;
}

describe('provider payload rewrite', () => {
	it('sends documents to Anthropic as native document blocks', async () => {
		const payload = await capturePayload(
			anthropicMessagesApi() as never,
			model('anthropic-messages', 'anthropic', 'claude-test'),
			documentContext(),
		);
		const [message] = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
		expect(message?.content[1]).toMatchObject({
			type: 'image',
			source: { type: 'base64', media_type: 'image/png', data: PNG },
		});
		expect(message?.content[2]).toMatchObject({
			type: 'document',
			title: 'quote.pdf',
			source: { type: 'base64', media_type: 'application/pdf', data: PDF },
		});
	});

	it('sends documents to OpenAI Responses as input_file parts', async () => {
		const payload = await capturePayload(
			openAIResponsesApi() as never,
			model('openai-responses', 'openai', 'gpt-test'),
			documentContext(),
		);
		const user = (payload.input as Array<Record<string, unknown>>).find(
			(item) => item.role === 'user',
		) as { content: Array<Record<string, unknown>> };
		expect(user.content[1]).toMatchObject({ type: 'input_image' });
		expect(user.content[2]).toEqual({
			type: 'input_file',
			filename: 'quote.pdf',
			file_data: `data:application/pdf;base64,${PDF}`,
		});
	});

	it('leaves Google inlineData untouched (already native)', async () => {
		const payload = await capturePayload(
			googleGenerativeAIApi() as never,
			model('google-generative-ai', 'google', 'gemini-test'),
			documentContext(),
		);
		const [content] = payload.contents as Array<{ parts: Array<Record<string, unknown>> }>;
		expect(content?.parts[2]).toEqual({ inlineData: { mimeType: 'application/pdf', data: PDF } });
	});

	it('replaces documents with a placeholder for unsupported APIs', async () => {
		const target = model('bedrock-converse-stream', 'amazon-bedrock', 'anthropic.claude-test');
		const prepared = prepareDocumentRequest(target, documentContext(), undefined);
		const [message] = prepared.context.messages;
		expect(message?.content).toEqual([
			{ type: 'text', text: 'Summarize this quote.' },
			{ type: 'image', data: PNG, mimeType: 'image/png' },
			{ type: 'text', text: documentOmittedPlaceholder('bedrock-converse-stream', 'quote.pdf') },
		]);
		// Bedrock throws on a non-image ImageContent; the placeholder keeps the
		// request buildable.
		const payload = await capturePayload(
			bedrockConverseStreamApi() as never,
			target,
			documentContext(),
		).catch((error: unknown) => error);
		expect(payload).not.toBeInstanceOf(Error);
	});

	it('is a no-op without documents', () => {
		const context: Context = {
			messages: [
				{
					role: 'user',
					timestamp: 0,
					content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
				},
			],
		};
		const options = { apiKey: 'k' };
		const prepared = prepareDocumentRequest(
			model('anthropic-messages', 'anthropic', 'claude-test'),
			context,
			options,
		);
		expect(prepared.context).toBe(context);
		expect(prepared.options).toBe(options);
	});
});

describe('attachment shapes', () => {
	it('folds documents into the image carrier and back', () => {
		const merged = mergeOperationAttachments(
			[{ type: 'image', data: PNG, mimeType: 'image/png' }],
			[{ type: 'document', data: PDF, mimeType: 'application/pdf' }],
		);
		expect(merged).toEqual([
			{ type: 'image', data: PNG, mimeType: 'image/png' },
			{ type: 'image', data: PDF, mimeType: 'application/pdf' },
		]);
		expect(merged?.map(toPublicAttachment).map((block) => block.type)).toEqual([
			'image',
			'document',
		]);
	});

	it('rejects unsupported document MIME types', () => {
		expect(() =>
			mergeOperationAttachments(undefined, [
				{ type: 'document', data: PDF, mimeType: 'application/msword' },
			]),
		).toThrow(/Unsupported document mimeType/);
		let rejection: unknown;
		try {
			parseDeliveredMessage({
				kind: 'user',
				body: 'hi',
				attachments: [{ type: 'document', data: PDF, mimeType: 'text/html' }],
			});
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toMatchObject({
			details: 'Document mimeType must be one of: application/pdf.',
		});
	});

	it('accepts document attachments on the wire', () => {
		expect(
			parseDeliveredMessage({
				kind: 'user',
				body: 'hi',
				attachments: [
					{ type: 'image', data: PNG, mimeType: 'image/png' },
					{ type: 'document', data: PDF, mimeType: 'application/pdf', filename: 'quote.pdf' },
				],
			}),
		).toMatchObject({ attachments: [{ type: 'image' }, { type: 'document' }] });
	});
});

describe('end to end', () => {
	async function runWithDocument(api: string) {
		function DocumentAgent() {
			useModel('faux/model', { compaction: false });
			return 'Reply to the user.';
		}
		const faux = fauxProvider({ api, models: [{ id: 'model', input: ['text', 'image'] }] });
		const seen: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		faux.setResponses([
			(context, options) => {
				seen.push({ context, options: options as SimpleStreamOptions | undefined });
				return fauxAssistantMessage([fauxText('Summarized.')], { stopReason: 'stop' });
			},
		]);
		const runtime = await start({
			agents: [DocumentAgent],
			db: sqlite(),
			providers: [faux.provider],
			env: {},
		});
		const agent = init(DocumentAgent, { id: `document-${api}` });
		try {
			await expect(
				agent.read(
					await agent.dispatch({
						message: {
							kind: 'user',
							body: 'Summarize this quote.',
							attachments: [
								{ type: 'document', data: PDF, mimeType: 'application/pdf', filename: 'quote.pdf' },
							],
						},
					}),
				),
			).resolves.toMatchObject({ text: 'Summarized.' });
		} finally {
			await agent.abort();
			await runtime.stop();
		}
		const request = seen[0];
		if (!request) throw new Error('model was not called');
		const user = request.context.messages.find((message) => message.role === 'user');
		if (!user || !Array.isArray(user.content)) throw new Error('user message missing');
		return { request, content: user.content };
	}

	it('persists a delivered document and forwards it with a native rewrite', async () => {
		const { request, content } = await runWithDocument('anthropic-messages');
		const text = content.find((block) => block.type === 'text');
		expect(text?.type === 'text' && text.text).toMatch(
			/<document id="[^"]+" mimeType="application\/pdf" filename="quote\.pdf" \/>/,
		);
		expect(content).toContainEqual({
			type: 'image',
			data: PDF,
			mimeType: 'application/pdf',
			filename: 'quote.pdf',
		});
		const rewritten = await request.options?.onPayload?.(
			{
				messages: [
					{
						role: 'user',
						content: [
							{
								type: 'image',
								source: { type: 'base64', media_type: 'application/pdf', data: PDF },
							},
						],
					},
				],
			},
			model('anthropic-messages', 'anthropic', 'claude-test'),
		);
		expect(rewritten).toMatchObject({
			messages: [{ content: [{ type: 'document', title: 'quote.pdf' }] }],
		});
	});

	it('replaces a delivered document with a placeholder on an unsupported API', async () => {
		const { content } = await runWithDocument('faux');
		expect(content).toContainEqual({
			type: 'text',
			text: documentOmittedPlaceholder('faux', 'quote.pdf'),
		});
		expect(content.some((block) => block.type === 'image')).toBe(false);
	});
});
