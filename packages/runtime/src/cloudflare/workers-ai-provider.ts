/**
 * Pi-ai provider that dispatches via `env.AI.run()` instead of HTTP.
 * Registered under the `cloudflare-ai-binding` API.
 *
 * Binding access: the generated entry captures `env.AI` at module init and
 * stores it on the resolved Model as a non-pi-ai `binding` field.
 *
 * Wire format: the binding accepts multiple Cloudflare model families. Workers
 * AI and OpenAI-family models use the OpenAI-compatible shape; Anthropic AI
 * Gateway models use Anthropic Messages.
 */
import type { Ai } from '@cloudflare/workers-types';
import type {
	AnthropicOptions,
	ApiProvider,
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
	Usage,
} from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream, parseStreamingJson } from '@earendil-works/pi-ai/compat';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertMessages } from '@earendil-works/pi-ai/api/openai-completions';
import { CLOUDFLARE_AI_BINDING_API, type CloudflareAIBindingApi } from '../cloudflare-model.ts';
import { CloudflareAIBindingError } from '../errors.ts';
import { getModelBinding, getModelGateway } from '../runtime/providers.ts';
import type { CloudflareGatewayOptions } from './gateway.ts';

// ─── OpenAI-completions compat profile ──────────────────────────────────────

/**
 * Mirrors pi-ai's effective compat for Workers AI models: `getCompat()`, i.e.
 * `detectCompat('cloudflare-workers-ai')` plus the per-model `compat`
 * overrides in pi-ai's model registry (which set `sendSessionAffinityHeaders:
 * true`; `detectCompat` alone returns `false`). Hardcoded here because
 * `convertMessages` requires a fully-resolved compat object and the binding's
 * wire format matches `cloudflare-workers-ai` exactly. Re-mirror if pi-ai's
 * detection logic or registry overrides change upstream. Note
 * `sendSessionAffinityHeaders` is inert in this provider — it applies the
 * `x-session-affinity` header itself in `streamCloudflareWorkersAi`.
 */
const WORKERS_AI_COMPAT: Required<Omit<OpenAICompletionsCompat, 'cacheControlFormat'>> & {
	cacheControlFormat?: OpenAICompletionsCompat['cacheControlFormat'];
} = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: 'max_completion_tokens',
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: 'openai',
	chatTemplateKwargs: {},
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: true,
	supportsLongCacheRetention: false,
};

// ─── Tool conversion ────────────────────────────────────────────────────────

interface OpenAIToolFunctionDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: unknown;
		strict?: boolean;
	};
}

function convertTools(tools: Tool[]): OpenAIToolFunctionDef[] {
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			// Match pi-ai's openai-completions for providers that support the
			// field (WORKERS_AI_COMPAT.supportsStrictMode is true).
			strict: false,
		},
	}));
}

// ─── Stream function ────────────────────────────────────────────────────────

interface ChatCompletionDelta {
	content?: string | null;
	reasoning_content?: string | null;
	reasoning?: string | null;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface ChatCompletionChoice {
	index?: number;
	delta?: ChatCompletionDelta;
	finish_reason?: string | null;
	usage?: ChatCompletionUsage;
}

interface ChatCompletionUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatCompletionChunk {
	id?: string;
	model?: string;
	choices?: ChatCompletionChoice[];
	usage?: ChatCompletionUsage;
}

type WorkersAIReasoningEffort = 'low' | 'medium' | 'high';

interface StreamingTextBlock {
	type: 'text';
	text: string;
}
interface StreamingThinkingBlock {
	type: 'thinking';
	thinking: string;
	thinkingSignature?: string;
}
interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}
type StreamingBlock = StreamingTextBlock | StreamingThinkingBlock | StreamingToolCallBlock;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseChunkUsage(raw: ChatCompletionUsage): Usage {
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? 0;
	const promptTokens = raw.prompt_tokens ?? 0;
	const completionTokens = raw.completion_tokens ?? 0;
	const input = Math.max(0, promptTokens - cacheRead);
	const totalTokens = raw.total_tokens ?? promptTokens + completionTokens;
	return {
		input,
		output: completionTokens,
		cacheRead,
		cacheWrite: 0,
		totalTokens,
		// Workers AI billing is account-level (Neurons); per-token cost is unknown.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(reason: string): {
	stopReason: AssistantMessage['stopReason'];
	errorMessage?: string;
} {
	switch (reason) {
		case 'stop':
		case 'eos':
			return { stopReason: 'stop' };
		case 'length':
			return { stopReason: 'length' };
		case 'tool_calls':
		case 'function_call':
			return { stopReason: 'toolUse' };
		case 'content_filter':
			return {
				stopReason: 'error',
				errorMessage: 'Provider stopped generation: content filter',
			};
		default:
			return {
				stopReason: 'error',
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

async function* iterateSseChunks(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finished = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				buffer += decoder.decode();
				if (buffer.trim().length > 0) {
					yield* parseSseEvents(buffer);
				}
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = findSseBoundary(buffer);
			while (boundary) {
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.width);
				yield* parseSseEvents(block);
				boundary = findSseBoundary(buffer);
			}
		}
	} finally {
		if (!finished) {
			// Early exit before `done`: cancel so workerd doesn't keep the
			// underlying AI request streaming with no consumer.
			try {
				await reader.cancel();
			} catch {}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

function findSseBoundary(buffer: string): { index: number; width: number } | null {
	const lf = buffer.indexOf('\n\n');
	const crlf = buffer.indexOf('\r\n\r\n');
	if (lf === -1 && crlf === -1) return null;
	if (lf === -1) return { index: crlf, width: 4 };
	if (crlf === -1) return { index: lf, width: 2 };
	return lf < crlf ? { index: lf, width: 2 } : { index: crlf, width: 4 };
}

function* parseSseEvents(block: string): IterableIterator<unknown> {
	// Per the SSE spec, an event's data may span multiple `data:` lines that
	// must be joined with '\n' before dispatch.
	const dataLines: string[] = [];
	let start = 0;
	while (start <= block.length) {
		const newline = block.indexOf('\n', start);
		const end = newline === -1 ? block.length : newline;
		const lineEnd = end > start && block.charCodeAt(end - 1) === 13 ? end - 1 : end;
		const line = block.slice(start, lineEnd);
		if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).trimStart());
		}
		if (newline === -1) break;
		start = newline + 1;
	}
	if (dataLines.length === 0) return;
	const data = dataLines.join('\n');
	if (data === '' || data === '[DONE]') return;
	try {
		yield JSON.parse(data);
	} catch {
		console.error(`Workers AI: dropping unparseable SSE data payload: ${data.slice(0, 200)}`);
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

const streamCloudflareWorkersAi: StreamFunction<CloudflareAIBindingApi, SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	if (isAnthropicGatewayModel(model)) {
		return streamCloudflareAnthropicAi(model, context, options);
	}

	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: 'assistant',
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: 'stop',
			timestamp: Date.now(),
		};

		let response: Response | undefined;
		try {
			const ai = resolveBinding(model);
			const messages = convertMessages(
				// `convertMessages` is typed for `Model<'openai-completions'>` but
				// only reads provider/id/reasoning, which our model has.
				model as unknown as Model<'openai-completions'>,
				context,
				WORKERS_AI_COMPAT,
			);

			const payload: Record<string, unknown> = {
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (context.tools && context.tools.length > 0) {
				payload.tools = convertTools(context.tools);
			}
			if (options?.maxTokens) {
				// Workers AI uses `max_completion_tokens` (see WORKERS_AI_COMPAT).
				payload.max_completion_tokens = options.maxTokens;
			}
			if (options?.temperature !== undefined) {
				payload.temperature = options.temperature;
			}
			applyReasoningEffort(payload, model, options?.reasoning);

			// `onPayload`: undefined keeps the payload, any other return replaces it.
			const overridden = await options?.onPayload?.(payload, model);
			const finalPayload = overridden === undefined ? payload : (overridden as typeof payload);

			const extraHeaders = buildExtraHeaders(options);

			// `Ai.run` only types overloads for known model IDs; we route
			// arbitrary ids through the unknown-model overload (see RunOverload).
			// `returnRawResponse: true` + `stream: true` in the payload gives us
			// the raw SSE Response we parse below.
			const gateway = getModelGateway(model);
			response = (await (ai.run as unknown as RunOverload)(model.id, finalPayload, {
				returnRawResponse: true,
				...(options?.signal ? { signal: options.signal } : {}),
				...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
				...(gateway ? { gateway } : {}),
			})) as Response;

			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);

			await assertSuccessfulBindingResponse(response);

			if (!response.body) {
				throw new CloudflareAIBindingError({ message: 'Cloudflare AI binding returned empty response body.' });
			}

			stream.push({ type: 'start', partial: output });

			let textBlock: StreamingTextBlock | null = null;
			let thinkingBlock: StreamingThinkingBlock | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const indexOf = (block: StreamingBlock | null): number =>
				block ? blocks.indexOf(block) : -1;

			const finishBlock = (block: StreamingBlock): void => {
				const contentIndex = indexOf(block);
				if (contentIndex === -1) return;
				if (block.type === 'text') {
					stream.push({
						type: 'text_end',
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === 'thinking') {
					stream.push({
						type: 'thinking_end',
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === 'toolCall') {
					block.arguments = parseStreamingJson(block.partialArgs ?? '');
					delete block.partialArgs;
					delete block.streamIndex;
					stream.push({
						type: 'toolcall_end',
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};

			const ensureTextBlock = (): StreamingTextBlock => {
				if (!textBlock) {
					textBlock = { type: 'text', text: '' };
					blocks.push(textBlock);
					stream.push({
						type: 'text_start',
						contentIndex: indexOf(textBlock),
						partial: output,
					});
				}
				return textBlock;
			};

			const ensureThinkingBlock = (thinkingSignature: string): StreamingThinkingBlock => {
				if (!thinkingBlock) {
					thinkingBlock = { type: 'thinking', thinking: '', thinkingSignature };
					blocks.push(thinkingBlock);
					stream.push({
						type: 'thinking_start',
						contentIndex: indexOf(thinkingBlock),
						partial: output,
					});
				}
				return thinkingBlock;
			};

			const ensureToolCallBlock = (toolCall: {
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}): StreamingToolCallBlock => {
				const streamIndex = typeof toolCall.index === 'number' ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					block = {
						type: 'toolCall',
						id: toolCall.id ?? '',
						name: toolCall.function?.name ?? '',
						arguments: {},
						partialArgs: '',
						streamIndex,
					} satisfies StreamingToolCallBlock;
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: 'toolcall_start',
						contentIndex: indexOf(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				return block;
			};

			for await (const rawChunk of iterateSseChunks(response.body)) {
				const chunk = rawChunk as ChatCompletionChunk | null;
				if (!chunk || typeof chunk !== 'object') continue;
				output.responseId ||= chunk.id;
				if (typeof chunk.model === 'string' && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage);
				}
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;
				if (!chunk.usage && choice.usage) {
					output.usage = parseChunkUsage(choice.usage);
				}
				if (choice.finish_reason) {
					const mapped = mapStopReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
					hasFinishReason = true;
				}

				const delta = choice.delta;
				if (!delta) continue;

				if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
					const block = ensureTextBlock();
					block.text += delta.content;
					stream.push({
						type: 'text_delta',
						contentIndex: indexOf(block),
						delta: delta.content,
						partial: output,
					});
				}

				const reasoningDelta = pickReasoning(delta);
				if (reasoningDelta) {
					const block = ensureThinkingBlock(reasoningDelta.field);
					block.thinking += reasoningDelta.text;
					stream.push({
						type: 'thinking_delta',
						contentIndex: indexOf(block),
						delta: reasoningDelta.text,
						partial: output,
					});
				}

				if (delta.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						const block = ensureToolCallBlock(toolCall);
						if (!block.id && toolCall.id) {
							block.id = toolCall.id;
							toolCallBlocksById.set(toolCall.id, block);
						}
						if (!block.name && toolCall.function?.name) {
							block.name = toolCall.function.name;
						}
						let toolDelta = '';
						if (toolCall.function?.arguments) {
							toolDelta = toolCall.function.arguments;
							block.partialArgs = (block.partialArgs ?? '') + toolDelta;
							block.arguments = parseStreamingJson(block.partialArgs);
						}
						stream.push({
							type: 'toolcall_delta',
							contentIndex: indexOf(block),
							delta: toolDelta,
							partial: output,
						});
					}
				}
			}

			for (const block of blocks) {
				finishBlock(block);
			}

			if (options?.signal?.aborted) {
				throw new Error('Request was aborted');
			}
			if (output.stopReason === 'error') {
				throw new Error(output.errorMessage ?? 'Provider returned an error stop reason');
			}
			if (!hasFinishReason) {
				throw new Error('Stream ended without finish_reason');
			}

			// `aborted` is statically possible on AssistantMessage but unreachable
			// here: only the catch handler assigns it (mapStopReason never returns
			// it), and `error` was thrown above.
			stream.push({
				type: 'done',
				reason: output.stopReason as Extract<
					AssistantMessage['stopReason'],
					'stop' | 'length' | 'toolUse'
				>,
				message: output,
			});
			stream.end();
		} catch (error) {
			// Cancel an unconsumed body so workerd doesn't keep the underlying AI
			// request open (and the model generating) with no consumer.
			if (response?.body && !response.body.locked) {
				void response.body.cancel().catch(() => {});
			}
			// Match openai-completions: strip scratch fields from in-flight blocks
			// before they're exposed on the error event.
			for (const block of output.content as StreamingBlock[]) {
				if (block.type === 'toolCall') {
					delete (block as StreamingToolCallBlock).partialArgs;
					delete (block as StreamingToolCallBlock).streamIndex;
				}
			}
			output.stopReason = options?.signal?.aborted || isAbortError(error) ? 'aborted' : 'error';
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: 'error', reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

function streamCloudflareAnthropicAi(
	model: Model<CloudflareAIBindingApi>,
	context: Context,
	options?: SimpleStreamOptions,
) {
	const ai = resolveBinding(model);
	const gateway = getModelGateway(model);
	const anthropicModel = toAnthropicGatewayModel(model);
	const client = createAnthropicBindingClient(ai, model, options, gateway);

	return streamAnthropic(anthropicModel, context, {
		...options,
		client,
		cacheRetention: 'none',
		thinkingEnabled: Boolean(options?.reasoning),
		onPayload: async (payload, payloadModel) => {
			const normalized = normalizeAnthropicGatewayPayload(payload as Record<string, unknown>);
			const overridden = await options?.onPayload?.(normalized, payloadModel);
			return overridden === undefined
				? normalized
				: normalizeAnthropicGatewayPayload(overridden as Record<string, unknown>);
		},
	} satisfies AnthropicOptions);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Narrowed `Ai.run` shape for the unknown-model overload. */
type RunOverload = (
	model: string,
	inputs: Record<string, unknown>,
	options?: {
		returnRawResponse?: boolean;
		signal?: AbortSignal;
		extraHeaders?: Record<string, string>;
		gateway?: CloudflareGatewayOptions;
	},
) => Promise<Response | Record<string, unknown>>;

function isAnthropicGatewayModel(model: Model<CloudflareAIBindingApi>): boolean {
	return model.id.startsWith('anthropic/');
}

function toAnthropicGatewayModel(
	model: Model<CloudflareAIBindingApi>,
): Model<'anthropic-messages'> {
	return {
		...model,
		api: 'anthropic-messages',
		baseUrl: '',
		compat: {
			supportsCacheControlOnTools: false,
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: false,
			sendSessionAffinityHeaders: false,
		},
	};
}

function createAnthropicBindingClient(
	ai: Ai,
	model: Model<CloudflareAIBindingApi>,
	options: SimpleStreamOptions | undefined,
	gateway: CloudflareGatewayOptions | undefined,
): AnthropicOptions['client'] {
	return {
		messages: {
			create(params: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }) {
				return {
					async asResponse() {
						const extraHeaders = buildExtraHeaders(options);
						const response = (await (ai.run as unknown as RunOverload)(model.id, params, {
							returnRawResponse: true,
							...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
							...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
							...(gateway ? { gateway } : {}),
						})) as Response;

						await assertSuccessfulBindingResponse(response);
						return response;
					},
				};
			},
		},
	} as unknown as AnthropicOptions['client'];
}

function buildExtraHeaders(options: SimpleStreamOptions | undefined): Record<string, string> {
	const extraHeaders: Record<string, string> = {};
	if (options?.sessionId) {
		// Pins related requests to the same model instance, enabling provider-side
		// prompt prefix caching where the Cloudflare binding supports it.
		extraHeaders['x-session-affinity'] = options.sessionId;
	}
	if (options?.headers) {
		Object.assign(extraHeaders, options.headers);
	}
	return extraHeaders;
}

function normalizeAnthropicGatewayPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const system = payload.system;
	if (Array.isArray(system)) {
		const text = system
			.map((block) => {
				if (typeof block === 'string') return block;
				if (block && typeof block === 'object' && 'text' in block) {
					const value = (block as { text?: unknown }).text;
					return typeof value === 'string' ? value : '';
				}
				return '';
			})
			.filter((text) => text.length > 0)
			.join('\n\n');
		if (text.length > 0) {
			return { ...payload, system: text };
		}
		const { system: _system, ...rest } = payload;
		return rest;
	}
	return payload;
}

async function assertSuccessfulBindingResponse(response: Response): Promise<void> {
	if (response.ok) return;
	const body = await safeReadText(response);
	throw new CloudflareAIBindingError({
		status: response.status,
		statusText: response.statusText,
		body,
	});
}

/**
 * Read the binding extension carried on the resolved Model.
 */
function resolveBinding(model: Model<CloudflareAIBindingApi>): Ai {
	const ai = getModelBinding(model);
	if (!ai) {
		throw new CloudflareAIBindingError({
			message:
				'Cloudflare AI binding not available. Models prefixed with "cloudflare/" require a configured AI binding.',
		});
	}
	return ai as Ai;
}

function pickReasoning(delta: ChatCompletionDelta): { field: string; text: string } | null {
	for (const field of ['reasoning_content', 'reasoning'] as const) {
		const value = delta[field];
		if (typeof value === 'string' && value.length > 0) {
			return { field, text: value };
		}
	}
	return null;
}

function applyReasoningEffort(
	payload: Record<string, unknown>,
	model: Model<CloudflareAIBindingApi>,
	level: SimpleStreamOptions['reasoning'] | undefined,
): void {
	if (!model.reasoning || level === undefined) return;
	payload.reasoning_effort = mapReasoningEffort(level);
}

function mapReasoningEffort(
	level: NonNullable<SimpleStreamOptions['reasoning']>,
): WorkersAIReasoningEffort {
	switch (level) {
		case 'minimal':
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
		case 'xhigh':
		case 'max':
			return 'high';
	}
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

async function safeReadText(response: Response): Promise<string | undefined> {
	try {
		return await response.text();
	} catch {
		return undefined;
	}
}

// ─── Registration ──────────────────────────────────────────────────────────

/**
 * Return the pi-ai `ApiProvider` definition for the Cloudflare AI binding.
 */
export function getCloudflareAIBindingApiProvider(): ApiProvider<
	CloudflareAIBindingApi,
	StreamOptions
> {
	return {
		api: CLOUDFLARE_AI_BINDING_API,
		stream: streamCloudflareWorkersAi,
		streamSimple: streamCloudflareWorkersAi,
	};
}
