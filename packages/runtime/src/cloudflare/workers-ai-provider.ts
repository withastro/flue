/**
 * Pi-ai provider that dispatches via `env.AI.run()` instead of HTTP.
 * Registered under the `cloudflare-ai-binding` API.
 *
 * Binding access: the generated entry captures `env.AI` at module init and
 * stores it on the resolved Model as a non-pi-ai `binding` field.
 *
 * Wire format: Workers AI accepts the OpenAI-completions request body, so
 * we translate via pi-ai's `convertMessages` and parse the binding's SSE
 * response with pi-ai's `AssistantMessageEvent` stream.
 */
import type { Ai } from '@cloudflare/workers-types';
import type {
	ApiProvider,
	AssistantMessage,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
	Usage,
} from '@mariozechner/pi-ai';
import {
	createAssistantMessageEventStream,
	parseStreamingJson,
} from '@mariozechner/pi-ai';
import { convertMessages } from '@mariozechner/pi-ai/openai-completions';
import { CLOUDFLARE_AI_BINDING_API, type CloudflareAIBindingApi } from '../cloudflare-model.ts';
import { getModelBinding } from '../runtime/providers.ts';
import type { CloudflareGatewayOptions } from './gateway.ts';

// ─── OpenAI-completions compat profile ──────────────────────────────────────

/**
 * Mirrors pi-ai's `detectCompat('cloudflare-workers-ai')`. Hardcoded here
 * because `convertMessages` requires a fully-resolved compat object and the
 * binding's wire format matches `cloudflare-workers-ai` exactly. Re-mirror
 * if pi-ai's detection logic changes upstream.
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
			// Match pi-ai's openai-completions: emit `strict: false` only when the
			// provider supports the field (some reject unknown fields outright).
			...(WORKERS_AI_COMPAT.supportsStrictMode !== false && { strict: false }),
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
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim().length > 0) {
					yield* parseSseEvents(buffer);
				}
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let separatorIndex = buffer.indexOf('\n\n');
			while (separatorIndex !== -1) {
				const block = buffer.slice(0, separatorIndex);
				buffer = buffer.slice(separatorIndex + 2);
				yield* parseSseEvents(block);
				separatorIndex = buffer.indexOf('\n\n');
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader already errored; nothing to release.
		}
	}
}

function* parseSseEvents(block: string): IterableIterator<unknown> {
	for (const rawLine of block.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line.startsWith('data:')) continue;
		const data = line.slice(5).trimStart();
		if (data === '' || data === '[DONE]') continue;
		try {
			yield JSON.parse(data);
		} catch {
			// Skip malformed lines; don't fail the whole stream.
		}
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

const streamCloudflareWorkersAi: StreamFunction<CloudflareAIBindingApi, StreamOptions> = (
	model,
	context,
	options,
) => {
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

			// `onPayload`: undefined keeps the payload, any other return replaces it.
			const overridden = await options?.onPayload?.(payload, model);
			const finalPayload = overridden === undefined ? payload : (overridden as typeof payload);

			const extraHeaders: Record<string, string> = {};
			if (options?.sessionId) {
				// Pins related requests to the same model instance, enabling
				// Workers AI's prompt prefix caching.
				extraHeaders['x-session-affinity'] = options.sessionId;
			}
			if (options?.headers) {
				Object.assign(extraHeaders, options.headers);
			}

			// `Ai.run` only types overloads for known model ids; we route
			// arbitrary ids through the unknown-model overload (see RunOverload).
			// `returnRawResponse: true` + `stream: true` in the payload gives us
			// the raw SSE Response we parse below.
			const gateway = (model as { gateway?: CloudflareGatewayOptions | false }).gateway;
			const response = (await (ai.run as unknown as RunOverload)(model.id, finalPayload, {
				returnRawResponse: true,
				...(options?.signal ? { signal: options.signal } : {}),
				...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
				...(gateway ? { gateway } : {}),
			})) as Response;

			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);

			if (!response.ok) {
				const errorBody = await safeReadText(response);
				throw new Error(
					`Cloudflare AI binding returned ${response.status} ${response.statusText}` +
						(errorBody ? `: ${errorBody}` : ''),
				);
			}

			if (!response.body) {
				throw new Error('Cloudflare AI binding returned empty response body.');
			}

			stream.push({ type: 'start', partial: output });

			let currentBlock: StreamingBlock | null = null;
			const blocks = output.content as StreamingBlock[];
			const indexOf = (block: StreamingBlock | null): number =>
				block ? blocks.indexOf(block) : -1;

			const finishCurrentBlock = (block: StreamingBlock | null): void => {
				if (!block) return;
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

			for await (const rawChunk of iterateSseChunks(response.body)) {
				const chunk = rawChunk as ChatCompletionChunk | null;
				if (!chunk || typeof chunk !== 'object') continue;
				output.responseId ||= chunk.id;
				if (
					typeof chunk.model === 'string' &&
					chunk.model.length > 0 &&
					chunk.model !== model.id
				) {
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
				}

				const delta = choice.delta;
				if (!delta) continue;

				if (
					delta.content !== null &&
					delta.content !== undefined &&
					delta.content.length > 0
				) {
					if (!currentBlock || currentBlock.type !== 'text') {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: 'text', text: '' };
						blocks.push(currentBlock);
						stream.push({
							type: 'text_start',
							contentIndex: indexOf(currentBlock),
							partial: output,
						});
					}
					currentBlock.text += delta.content;
					stream.push({
						type: 'text_delta',
						contentIndex: indexOf(currentBlock),
						delta: delta.content,
						partial: output,
					});
				}

				const reasoningDelta = pickReasoning(delta);
				if (reasoningDelta) {
					if (!currentBlock || currentBlock.type !== 'thinking') {
						finishCurrentBlock(currentBlock);
						currentBlock = {
							type: 'thinking',
							thinking: '',
							thinkingSignature: reasoningDelta.field,
						};
						blocks.push(currentBlock);
						stream.push({
							type: 'thinking_start',
							contentIndex: indexOf(currentBlock),
							partial: output,
						});
					}
					currentBlock.thinking += reasoningDelta.text;
					stream.push({
						type: 'thinking_delta',
						contentIndex: indexOf(currentBlock),
						delta: reasoningDelta.text,
						partial: output,
					});
				}

				if (delta.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						const streamIndex =
							typeof toolCall.index === 'number' ? toolCall.index : undefined;
						const continueExisting =
							currentBlock?.type === 'toolCall' &&
							((streamIndex !== undefined &&
								currentBlock.streamIndex === streamIndex) ||
								(streamIndex === undefined &&
									!!toolCall.id &&
									currentBlock.id === toolCall.id));
						if (!continueExisting) {
							finishCurrentBlock(currentBlock);
							currentBlock = {
								type: 'toolCall',
								id: toolCall.id ?? '',
								name: toolCall.function?.name ?? '',
								arguments: {},
								partialArgs: '',
								streamIndex,
							} satisfies StreamingToolCallBlock;
							blocks.push(currentBlock);
							stream.push({
								type: 'toolcall_start',
								contentIndex: indexOf(currentBlock),
								partial: output,
							});
						}
						const block =
							currentBlock?.type === 'toolCall' ? currentBlock : null;
						if (block) {
							if (!block.id && toolCall.id) block.id = toolCall.id;
							if (!block.name && toolCall.function?.name) {
								block.name = toolCall.function.name;
							}
							if (block.streamIndex === undefined && streamIndex !== undefined) {
								block.streamIndex = streamIndex;
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
			}

			finishCurrentBlock(currentBlock);

			if (options?.signal?.aborted) {
				throw new Error('Request was aborted');
			}
			if (output.stopReason === 'aborted') {
				throw new Error('Request was aborted');
			}
			if (output.stopReason === 'error') {
				throw new Error(output.errorMessage ?? 'Provider returned an error stop reason');
			}

			stream.push({ type: 'done', reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Match openai-completions: strip scratch fields from in-flight blocks
			// before they're exposed on the error event.
			for (const block of output.content as StreamingBlock[]) {
				if (block.type === 'toolCall') {
					delete (block as StreamingToolCallBlock).partialArgs;
					delete (block as StreamingToolCallBlock).streamIndex;
				}
			}
			output.stopReason =
				options?.signal?.aborted || isAbortError(error) ? 'aborted' : 'error';
			output.errorMessage =
				error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: 'error', reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

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

/**
 * Read the binding extension carried on the resolved Model.
 */
function resolveBinding(model: Model<CloudflareAIBindingApi>): Ai {
	const ai = getModelBinding(model);
	if (!ai) {
		throw new Error(
			'[flue] Cloudflare AI binding not available. ' +
				'Models prefixed with "cloudflare/" require running on the Cloudflare ' +
				'target with `"ai": { "binding": "AI" }` declared in wrangler.jsonc. ' +
				'For URL-based access without the binding, use pi-ai\'s ' +
				'`cloudflare-workers-ai/...` or `cloudflare-ai-gateway/...` providers ' +
				'(both require Cloudflare API credentials in env vars).',
		);
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
		// `SimpleStreamOptions` is a superset of `StreamOptions`; reuse is safe
		// because reasoning-effort / thinking-budget aren't sent to Workers AI.
		streamSimple: streamCloudflareWorkersAi as unknown as StreamFunction<
			CloudflareAIBindingApi,
			SimpleStreamOptions
		>,
	};
}
