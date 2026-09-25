/**
 * Pi-ai provider that dispatches via `env.AI.run()` instead of HTTP.
 *
 * Binding access: `cloudflareBindingProvider()` captures `env.AI` (and the
 * resolved AI Gateway options) in the provider's stream-function closure.
 *
 * Wire format: the binding accepts multiple Cloudflare model families, each
 * with its own serialization. `anthropic/…` AI Gateway models use Anthropic
 * Messages, `openai/…` AI Gateway models use OpenAI Responses, and everything
 * else — Workers AI `@cf/…` ids and other gateway vendors — uses the
 * OpenAI-compatible chat-completions shape. Catalogued gateway models dispatch
 * by their pi-ai catalog `api`; uncatalogued ids fall back to their vendor
 * prefix.
 */
import type { Ai } from '@cloudflare/workers-types';
import type {
	AnthropicEffort,
	AnthropicOptions,
	AssistantMessage,
	Model,
	OpenAICompletionsCompat,
	Provider,
	ProviderStreams,
	SimpleStreamOptions,
	ThinkingLevel,
	Tool,
	ToolCall,
	TranscriptContext,
	Usage,
} from '@earendil-works/pi-ai';
import {
	type Api,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentTools,
	parseStreamingJson,
	resolveTranscriptTools,
} from '@earendil-works/pi-ai';
// Protocol implementations load lazily, matching pi's own provider design:
// the worker entry imports this module in every isolate, but the ~90KB of
// wire-protocol code should cost nothing until a binding model streams.
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { CloudflareAIBindingError, RETRYABLE_INTERRUPTION_MARKER } from '../errors.ts';
import { attachProviderResponseDiagnostics } from '../provider-diagnostics.ts';
import { DYNAMIC_MODEL_TEMPLATE } from '../runtime/providers.ts';
import { prepareAnthropicBindingRequest } from './anthropic-binding-request.ts';
import type { CloudflareGatewayOptions } from './gateway.ts';

/**
 * The `api` marker carried by Workers AI catalog models and zero-metadata
 * dynamic ids. `bindingWireFormat` reads it (alongside the real gateway apis)
 * to pick a serialization; no pi-ai wire-protocol registry consults it.
 */
const CLOUDFLARE_AI_BINDING_API = 'cloudflare-ai-binding' as const;

// ─── OpenAI-completions compat profile ──────────────────────────────────────

/**
 * Base OpenAI-completions compat profile for the Workers AI binding, mirroring
 * pi-ai's `detectCompat('cloudflare-workers-ai')` result (`sendSessionAffinity-
 * Headers: true` — `detectCompat` alone returns `false`). Hardcoded here
 * because `convertMessages` requires a fully-resolved compat object and the
 * binding's wire format matches `cloudflare-workers-ai` exactly; per-model
 * catalog overrides are merged over it at request time (see the
 * chat-completions branch), mirroring pi's `getCompat()`. Re-mirror if
 * pi-ai's detection logic changes upstream. Note `sendSessionAffinityHeaders`
 * is inert in this provider — it applies the `x-session-affinity` header
 * itself in `streamCloudflareWorkersAi`.
 */
const WORKERS_AI_COMPAT: Omit<
	Required<OpenAICompletionsCompat>,
	'cacheControlFormat' | 'thinkingTokenBudgetField' | 'vllmPriority'
> & {
	cacheControlFormat?: OpenAICompletionsCompat['cacheControlFormat'];
} = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: 'max_completion_tokens',
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: 'openai',
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: true,
	sessionAffinityFormat: 'openai',
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

/**
 * Default cap on how long a model stream may go without delivering a single
 * byte before the request is failed as a retryable interruption. Generous on
 * purpose: long-thinking models can be legitimately silent for minutes when
 * neither keepalives nor reasoning deltas are streamed, and a false trip
 * burns a turn retry. The pathological case this exists for — a stream that
 * returned 200 and then never speaks again (#538) — is unbounded without it.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Wrap a response body so a chunk gap longer than `idleMs` rejects the read
 * with a retryable-interruption error instead of pending forever. The timer
 * only runs while a read is outstanding — consumer backpressure is not
 * source silence. `idleMs <= 0` disables the guard.
 */
function withStreamIdleDeadline(
	body: ReadableStream<Uint8Array>,
	idleMs: number,
): ReadableStream<Uint8Array> {
	if (idleMs <= 0) return body;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							reject(
								new Error(
									`Model stream stalled: no data received for ${Math.round(idleMs / 1000)}s ${RETRYABLE_INTERRUPTION_MARKER}`,
								),
							);
						}, idleMs);
					}),
				]);
				if (result.done) controller.close();
				else controller.enqueue(result.value);
			} catch (error) {
				// Cancel the source so workerd doesn't keep the underlying AI
				// request streaming with no consumer; the stalled read promise
				// is orphaned either way. cancel() rejects when the source
				// errored in the meantime — consume it, an unhandled rejection
				// is an exception on workerd.
				try {
					void reader.cancel().catch(() => {});
				} catch {}
				controller.error(error);
			} finally {
				clearTimeout(timer);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
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

/** Resolved per-provider streaming config threaded to every wire-format branch. */
interface CloudflareBindingStreamConfig {
	gateway: CloudflareGatewayOptions | undefined;
	streamIdleTimeoutMs: number;
	/** Anthropic prompt-cache retention for the binding's Anthropic path. */
	cacheRetention: 'none' | 'short' | 'long';
}

/**
 * The gateway shape forwarded to `ai.run` plus the headers carrying gateway
 * options with no binding-object equivalent (`requestTimeoutMs` →
 * `cf-aig-request-timeout`).
 */
function gatewayRunOptions(gateway: CloudflareGatewayOptions | undefined): {
	gateway?: Omit<CloudflareGatewayOptions, 'requestTimeoutMs'>;
	headers: Record<string, string>;
} {
	if (!gateway) return { headers: {} };
	const { requestTimeoutMs, ...forwarded } = gateway;
	return {
		gateway: forwarded,
		headers:
			requestTimeoutMs !== undefined && requestTimeoutMs > 0
				? { 'cf-aig-request-timeout': String(requestTimeoutMs) }
				: {},
	};
}

function streamCloudflareWorkersAi(
	ai: Ai,
	binding: CloudflareBindingStreamConfig,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	switch (bindingWireFormat(model)) {
		case 'anthropic-messages':
			return streamCloudflareAnthropicAi(ai, binding, model, context, options);
		case 'openai-responses':
			return streamCloudflareResponsesAi(ai, binding, model, context, options);
		case 'openai-completions':
			break;
		default:
			return unsupportedWireFormatStream(model);
	}
	const { gateway, streamIdleTimeoutMs } = binding;

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
			// Loaded on demand (module-cached after the first call); the static
			// specifier keeps bundlers chunking it normally.
			const { convertMessages } = await import('@earendil-works/pi-ai/api/openai-completions');
			// Per-model catalog compat overrides win over the hardcoded base
			// profile, mirroring pi's own `getCompat()` (detect + overrides).
			const compat = {
				...WORKERS_AI_COMPAT,
				...(model.compat as OpenAICompletionsCompat | undefined),
			};
			const messages = convertMessages(
				// `convertMessages` is typed for `Model<'openai-completions'>` but
				// only reads provider/id/reasoning, which our model has.
				model as unknown as Model<'openai-completions'>,
				context,
				compat,
			);

			const payload: Record<string, unknown> = {
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			// The binding receives a transcript context: tool declarations ride in
			// the transcript's system messages, never in `context.tools`. The
			// completions wire format has no mid-convo additions channel, so the
			// request always carries the full current tool set.
			const requestTools = getCurrentTools(context.messages);
			if (requestTools.length > 0) {
				payload.tools = convertTools(requestTools);
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

			const run = gatewayRunOptions(gateway);
			const extraHeaders = { ...buildExtraHeaders(options), ...run.headers };

			// `Ai.run` only types overloads for known model IDs; we route
			// arbitrary ids through the unknown-model overload (see RunOverload).
			// `returnRawResponse: true` + `stream: true` in the payload gives us
			// the raw SSE Response we parse below.
			response = (await (ai.run as unknown as RunOverload)(model.id, finalPayload, {
				returnRawResponse: true,
				...(options?.signal ? { signal: options.signal } : {}),
				...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
				...(run.gateway ? { gateway: run.gateway } : {}),
			})) as Response;

			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);

			// Response-level gateway correlation. This response's OWN header —
			// never env.AI.aiGatewayLogId, which reflects the binding's most
			// recent request and cross-attributes under concurrency.
			const gatewayLogId = response.headers.get('cf-aig-log-id');
			if (gatewayLogId) {
				attachProviderResponseDiagnostics(output, { gatewayLogId });
			}

			await assertSuccessfulBindingResponse(response);

			if (!response.body) {
				throw new CloudflareAIBindingError({
					message: 'Cloudflare AI binding returned empty response body.',
				});
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

			for await (const rawChunk of iterateSseChunks(
				withStreamIdleDeadline(response.body, streamIdleTimeoutMs),
			)) {
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
					// Retain the exact raw value beside the normalized stopReason so
					// observers can tell provider finish semantics apart (#492).
					attachProviderResponseDiagnostics(output, {
						providerFinishReason: choice.finish_reason,
					});
					const mapped = mapStopReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
					hasFinishReason = true;
				}

				const delta = choice.delta;
				if (!delta) continue;

				const textDelta = normalizeAssistantContent(delta.content);
				if (textDelta !== undefined && textDelta.length > 0) {
					const block = ensureTextBlock();
					block.text += textDelta;
					stream.push({
						type: 'text_delta',
						contentIndex: indexOf(block),
						delta: textDelta,
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
				// The stream ended with no error frame and no finish_reason: the
				// response was truncated in transit (known transient Workers AI
				// behavior under load), not a model outcome — safe to retry.
				throw new Error(`Stream ended without finish_reason ${RETRYABLE_INTERRUPTION_MARKER}`);
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
}

/**
 * Map a thinking level to Anthropic's adaptive-thinking effort. The binding
 * path calls pi-ai's low-level stream directly, which applies `effort` only
 * when it is set — pi's `streamSimple` is the only path that maps `reasoning`
 * to an effort, and this provider does not call it. Mirrors pi's
 * `mapThinkingLevelToEffort`: a string in the model's `thinkingLevelMap` wins;
 * otherwise `minimal`/`low` map to `low`, `medium` to `medium`, and everything
 * else to `high`.
 */
function mapThinkingLevelToEffort(
	model: Model<'anthropic-messages'>,
	level: ThinkingLevel,
): AnthropicEffort {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === 'string') return mapped as AnthropicEffort;
	switch (level) {
		case 'minimal':
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
			return 'high';
		default:
			return 'high';
	}
}

function streamCloudflareAnthropicAi(
	ai: Ai,
	binding: CloudflareBindingStreamConfig,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	warnZeroMetadataGatewayModel(model);
	const anthropicModel = toAnthropicGatewayModel(model, binding.cacheRetention);
	const client = createAnthropicBindingClient(ai, model, options, binding);

	// pi-ai's low-level stream writes `output_config: { effort }` only when
	// `effort` is set — the thinking level arrives as `options.reasoning`, which
	// only its `streamSimple` path maps to an effort. Map it here so
	// `thinkingLevel` takes effect on adaptive-thinking models.
	const effort =
		options?.reasoning && anthropicModel.compat?.forceAdaptiveThinking === true
			? mapThinkingLevelToEffort(anthropicModel, options.reasoning)
			: undefined;

	// The lazy shim types options as plain StreamOptions; the impl receives
	// the Anthropic-specific fields (client, thinkingEnabled) verbatim.
	const anthropicOptions: AnthropicOptions = {
		...options,
		client,
		cacheRetention: binding.cacheRetention,
		thinkingEnabled: Boolean(options?.reasoning),
		...(effort ? { effort } : {}),
		onPayload: async (payload, payloadModel) => {
			const normalized = normalizeAnthropicGatewayPayload(payload as Record<string, unknown>);
			const overridden = await options?.onPayload?.(normalized, payloadModel);
			return overridden === undefined
				? normalized
				: normalizeAnthropicGatewayPayload(overridden as Record<string, unknown>);
		},
	};
	return anthropicMessagesApi().stream(anthropicModel, context, anthropicOptions);
}

// ─── OpenAI Responses stream (AI Gateway `openai/…` models) ─────────────────

// OpenAI Responses rejects max_output_tokens below 16:
// https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * Providers whose tool-call ids carry OpenAI `call|item` pairing across turns.
 * This provider is not one (ids are sanitized instead), matching pi-ai's own
 * `cloudflare-ai-gateway` provider, whose id is likewise outside pi's set.
 */
const RESPONSES_TOOL_CALL_ID_PROVIDERS: ReadonlySet<string> = new Set();

function streamCloudflareResponsesAi(
	ai: Ai,
	binding: CloudflareBindingStreamConfig,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) {
	const { gateway } = binding;
	warnZeroMetadataGatewayModel(model);
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
		const observed = { sawTerminalEvent: false, endedCleanly: false };
		try {
			// Loaded on demand like the chat-completions converters above.
			const [
				{ convertResponsesMessages, convertResponsesTools, processResponsesStream },
				{ clampOpenAIPromptCacheKey },
			] = await Promise.all([
				import('@earendil-works/pi-ai/api/openai-responses-shared'),
				import('@earendil-works/pi-ai/api/openai-prompt-cache'),
			]);

			const responsesModel = toResponsesGatewayModel(model);
			// Deferred tool loading (`additional_tools` / tool_search) is the
			// model's own channel when its compat advertises it; without it, the
			// full current tool set rides in the request-level `tools` field.
			// The three compat booleans mirror pi's own Responses builder
			// (`buildParams`): independent flags, and request tools resolved
			// with their OR.
			const supportsAdditionalTools = responsesModel.compat?.supportsAdditionalTools === true;
			const supportsToolSearch = responsesModel.compat?.supportsToolSearch === true;
			const supportsMidConvoSystemMessages =
				responsesModel.compat?.supportsMidConvoSystemMessages === true;
			const supportsToolAdditions = supportsAdditionalTools || supportsToolSearch;
			const payload: Record<string, unknown> = {
				// `ai.run`'s model argument names the gateway target; like the
				// chat-completions payload, the body carries no `model` field.
				input: convertResponsesMessages(responsesModel, context, RESPONSES_TOOL_CALL_ID_PROVIDERS, {
					supportsAdditionalTools,
					supportsToolSearch,
					supportsMidConvoSystemMessages,
				}),
				stream: true,
				store: false,
			};
			// Transcript context: the tool set lives in the transcript's system
			// messages. `convertResponsesMessages` renders mid-convo additions as
			// `additional_tools` items only when the model advertises the channel;
			// request-level tools mirror the same split via the request-tools
			// projection so added definitions never leak into the cached prefix.
			const { requestTools } = resolveTranscriptTools(context.messages, supportsToolAdditions);
			if (requestTools.length > 0) {
				payload.tools = convertResponsesTools(requestTools);
			}
			if (options?.maxTokens) {
				payload.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
			}
			if (options?.temperature !== undefined) {
				payload.temperature = options.temperature;
			}
			if (options?.sessionId) {
				payload.prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId);
			}
			applyResponsesReasoning(payload, responsesModel, options?.reasoning);

			// `onPayload`: undefined keeps the payload, any other return replaces it.
			const overridden = await options?.onPayload?.(payload, model);
			const finalPayload = overridden === undefined ? payload : (overridden as typeof payload);

			const run = gatewayRunOptions(gateway);
			const extraHeaders = { ...buildExtraHeaders(options), ...run.headers };
			response = (await (ai.run as unknown as RunOverload)(model.id, finalPayload, {
				returnRawResponse: true,
				...(options?.signal ? { signal: options.signal } : {}),
				...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
				...(run.gateway ? { gateway: run.gateway } : {}),
			})) as Response;

			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);

			// Response-level gateway correlation. This response's OWN header —
			// never env.AI.aiGatewayLogId, which reflects the binding's most
			// recent request and cross-attributes under concurrency.
			const gatewayLogId = response.headers.get('cf-aig-log-id');
			if (gatewayLogId) {
				attachProviderResponseDiagnostics(output, { gatewayLogId });
			}

			await assertSuccessfulBindingResponse(response);

			if (!response.body) {
				throw new CloudflareAIBindingError({
					message: 'Cloudflare AI binding returned empty response body.',
				});
			}

			stream.push({ type: 'start', partial: output });

			await processResponsesStream(
				observeResponsesEvents(
					iterateSseChunks(withStreamIdleDeadline(response.body, binding.streamIdleTimeoutMs)),
					observed,
				) as Parameters<typeof processResponsesStream>[0],
				output,
				stream,
				responsesModel,
			);

			if (options?.signal?.aborted) {
				throw new Error('Request was aborted');
			}
			// `processResponsesStream` throws when the stream ends without a
			// terminal `response.*` event, so a normal return has a real status.
			if (output.stopReason === 'aborted' || output.stopReason === 'error') {
				throw new Error(output.errorMessage ?? 'Provider returned an error stop reason');
			}
			// `pending` is the still-streaming stop reason: reaching it here means
			// the stream ended cleanly without a terminal status, the same
			// interruption the chat-completions path marks retryable.
			if (output.stopReason === 'pending') {
				throw new Error(`Stream ended without a terminal status ${RETRYABLE_INTERRUPTION_MARKER}`);
			}

			stream.push({ type: 'done', reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Cancel an unconsumed body so workerd doesn't keep the underlying AI
			// request open (and the model generating) with no consumer.
			if (response?.body && !response.body.locked) {
				void response.body.cancel().catch(() => {});
			}
			// Match openai-responses: strip streaming scratch fields from
			// in-flight blocks before they're exposed on the error event.
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			const aborted = options?.signal?.aborted || isAbortError(error);
			output.stopReason = aborted ? 'aborted' : 'error';
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			// A clean SSE end without a terminal `response.*` event is transit
			// truncation (the Responses analogue of a missing finish_reason above)
			// and safe to retry.
			output.errorMessage =
				!aborted && observed.endedCleanly && !observed.sawTerminalEvent
					? `${message} ${RETRYABLE_INTERRUPTION_MARKER}`
					: message;
			stream.push({ type: 'error', reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function toResponsesGatewayModel(model: Model<Api>): Model<'openai-responses'> {
	const converted: Model<'openai-responses'> = { ...model, api: 'openai-responses', baseUrl: '' };
	// The binding's /run validates reasoning.effort as none|low|medium|high even
	// when the model's own API accepts more, so drop the levels the transport
	// can't carry and let clampThinkingLevel land on the highest remaining one
	// (the same ceiling mapReasoningEffort applies on the chat-completions path).
	if (converted.thinkingLevelMap) {
		const { xhigh, max, ...bindingLevels } = converted.thinkingLevelMap;
		converted.thinkingLevelMap = bindingLevels;
	}
	return converted;
}

function applyResponsesReasoning(
	payload: Record<string, unknown>,
	model: Model<'openai-responses'>,
	level: SimpleStreamOptions['reasoning'] | undefined,
): void {
	if (!model.reasoning) return;
	const clamped = level ? clampThinkingLevel(model, level) : undefined;
	if (clamped && clamped !== 'off') {
		const effort = model.thinkingLevelMap?.[clamped] ?? clamped;
		payload.reasoning = { effort, summary: 'auto' };
		// Encrypted reasoning items make `store: false` multi-turn replay
		// stateless, mirroring pi's openai-responses request shape.
		payload.include = ['reasoning.encrypted_content'];
	} else if (model.thinkingLevelMap?.off !== null) {
		payload.reasoning = { effort: model.thinkingLevelMap?.off ?? 'none' };
	}
}

/**
 * Pass-through that records whether the SSE stream reached a terminal
 * `response.*` event and whether it ended cleanly, so the catch handler can
 * tell transit truncation apart from provider-reported errors.
 */
async function* observeResponsesEvents(
	events: AsyncIterable<unknown>,
	observed: { sawTerminalEvent: boolean; endedCleanly: boolean },
): AsyncIterable<unknown> {
	for await (const event of events) {
		const type = (event as { type?: unknown } | null)?.type;
		if (
			type === 'response.completed' ||
			type === 'response.incomplete' ||
			type === 'response.failed'
		) {
			observed.sawTerminalEvent = true;
		}
		yield event;
	}
	observed.endedCleanly = true;
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

type BindingWireFormat = 'anthropic-messages' | 'openai-completions' | 'openai-responses';

/**
 * The serialization a binding model speaks. Hydrated gateway models dispatch
 * by their catalog `api`; ids no catalog knows fall back to their gateway
 * vendor prefix. Everything else — `@cf/…` ids and unknown gateway vendors —
 * speaks OpenAI-compatible chat completions. An api with no wire format here
 * (possible if pi-ai's gateway catalog grows a new family) yields `undefined`
 * so the caller can error instead of serializing the wrong shape.
 */
function bindingWireFormat(model: Model<Api>): BindingWireFormat | undefined {
	if (model.api === 'anthropic-messages' || model.id.startsWith('anthropic/')) {
		return 'anthropic-messages';
	}
	if (model.api === 'openai-responses' || model.id.startsWith('openai/')) {
		return 'openai-responses';
	}
	if (model.api === 'openai-completions' || model.api === CLOUDFLARE_AI_BINDING_API) {
		return 'openai-completions';
	}
	return undefined;
}

const warnedZeroMetadataGatewayModels = new Set<string>();

/**
 * A gateway-prefixed id that reached a gateway branch with the binding's own
 * api marker resolved through the zero-metadata dynamic fallback: the wire
 * format is right (it came from the vendor prefix), but pi-ai's catalog
 * doesn't know the model, so image input degrades to text placeholders and
 * cost/context-window data is absent. Text conversations behave correctly,
 * which is exactly why the degradation deserves a log line — nothing else
 * surfaces it. `@cf/…` ids stay silent: chat completions needs no catalog
 * entry to serialize correctly.
 */
function warnZeroMetadataGatewayModel(model: Model<Api>): void {
	if (model.api !== CLOUDFLARE_AI_BINDING_API) return;
	if (warnedZeroMetadataGatewayModels.has(model.id)) return;
	warnedZeroMetadataGatewayModels.add(model.id);
	console.warn(
		`[flue] Model "cloudflare/${model.id}" is not in pi-ai's AI Gateway catalog; ` +
			`resolving with zero metadata. Image input is replaced with text placeholders, ` +
			`and cost and context-window data are unavailable. ` +
			`A newer @earendil-works/pi-ai release may include this model.`,
	);
}

function unsupportedWireFormatStream(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: 'error',
		errorMessage:
			`Cloudflare AI binding has no wire format for api "${model.api}" ` + `(model "${model.id}").`,
		timestamp: Date.now(),
	};
	stream.push({ type: 'error', reason: 'error', error: output });
	stream.end();
	return stream;
}

function toAnthropicGatewayModel(
	model: Model<Api>,
	cacheRetention: 'none' | 'short' | 'long',
): Model<'anthropic-messages'> {
	// The binding dialect forwards `cache_control` on message blocks and tools
	// to Anthropic, so tool markers are safe to emit when caching is on; the
	// 1-hour TTL (`supportsLongCacheRetention`) was not verified against the
	// binding, so 'long' falls back to the 5-minute TTL via pi's own compat
	// check. `sendSessionAffinityHeaders` is off because flue sends the
	// affinity header itself (buildExtraHeaders) — and a stable sessionId is
	// what makes the cache reusable across turns.
	const caching = cacheRetention !== 'none';
	return {
		...model,
		api: 'anthropic-messages',
		baseUrl: '',
		compat: {
			...model.compat,
			// pi's Anthropic compat accepts only the openrouter affinity format;
			// the binding sends `x-session-affinity` itself (buildExtraHeaders),
			// so drop whatever format the source catalog carried.
			sessionAffinityFormat: undefined,
			supportsCacheControlOnTools: caching,
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: false,
			sendSessionAffinityHeaders: false,
		},
	};
}

function createAnthropicBindingClient(
	ai: Ai,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	binding: CloudflareBindingStreamConfig,
): AnthropicOptions['client'] {
	// pi 0.87 calls `client.beta.messages.create` (0.83 used `messages.create`);
	// both namespaces share one request path so the wire stays version-agnostic.
	// The beta namespace translates `params.betas` into the `anthropic-beta`
	// header like the Anthropic SDK (see prepareAnthropicBindingRequest).
	type RequestOptions = { signal?: AbortSignal };
	const send = (
		namespace: 'messages' | 'beta',
		params: Record<string, unknown>,
		requestOptions: RequestOptions | undefined,
	) => {
		return {
			async asResponse() {
				const run = gatewayRunOptions(binding.gateway);
				const { body, extraHeaders } = prepareAnthropicBindingRequest(namespace, params, {
					...buildExtraHeaders(options),
					...run.headers,
				});
				const response = (await (ai.run as unknown as RunOverload)(model.id, body, {
					returnRawResponse: true,
					...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
					...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
					...(run.gateway ? { gateway: run.gateway } : {}),
				})) as Response;

				await assertSuccessfulBindingResponse(response);
				// pi-ai's Anthropic protocol consumes the body itself, so the
				// idle deadline wraps the Response it hands back.
				if (!response.body) return response;
				return new Response(
					withStreamIdleDeadline(response.body, binding.streamIdleTimeoutMs),
					response,
				);
			},
		};
	};
	return {
		messages: {
			create(params: Record<string, unknown>, requestOptions?: RequestOptions) {
				return send('messages', params, requestOptions);
			},
		},
		beta: {
			messages: {
				create(params: Record<string, unknown>, requestOptions?: RequestOptions) {
					return send('beta', params, requestOptions);
				},
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

function normalizeAnthropicGatewayPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
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

function normalizeAssistantContent(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === 'string') return value;
	const received = Array.isArray(value)
		? 'an array'
		: typeof value === 'object'
			? 'an object'
			: `a value of type ${typeof value}`;
	throw new CloudflareAIBindingError({
		message: `Cloudflare AI binding returned invalid choices[0].delta.content: expected a string, null, or an omitted field; received ${received}.`,
	});
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
	model: Model<Api>,
	level: SimpleStreamOptions['reasoning'] | undefined,
): void {
	if (!model.reasoning || level === undefined) return;
	payload.reasoning_effort = mapReasoningEffort(level);
}

/**
 * Ceiling for the binding's accepted effort values; the Responses path applies
 * the same ceiling by stripping xhigh/max in toResponsesGatewayModel.
 */
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

// ─── Provider factory ───────────────────────────────────────────────────────

/**
 * Minimal Workers AI binding shape. Kept structural so the factory type stays
 * importable on Node.
 */
export interface CloudflareAIBinding {
	run(
		modelId: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<Response | Record<string, unknown>>;
}

/**
 * Anthropic prompt-cache retention for the binding's Anthropic path
 * (`anthropic/…` gateway models). The Workers AI binding forwards
 * `cache_control` on message blocks and tools to Anthropic, so opt-in caching
 * serves repeated prefixes at the cached input rate instead of full price.
 * `'long'` requests the 1-hour TTL where the platform supports it. Default
 * `'none'` keeps the current behavior (no cache markers).
 */
export type CloudflareCacheRetention = 'none' | 'short' | 'long';

export interface CloudflareBindingProviderOptions {
	/** The captured `env.AI` reference. */
	binding: CloudflareAIBinding;
	/**
	 * AI Gateway options forwarded to every `env.AI.run(...)` call routed
	 * through this provider.
	 *
	 * - Omitted: routes through Cloudflare's default AI Gateway, which the
	 *   binding spins up on demand for the account.
	 * - Options object: replaces the default. Specify `id` plus any other
	 *   knobs (cache, metadata, logging).
	 * - `false`: opts out — no gateway is passed to `ai.run`.
	 *
	 * See https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/.
	 */
	gateway?: CloudflareGatewayOptions | false;
	/**
	 * Cap on how long a model stream may go without delivering a byte before
	 * the request fails as a retryable interruption (the turn retries under
	 * the transient-error budget). Defaults to 5 minutes — generous, because
	 * a long-thinking model can be legitimately silent when neither
	 * keepalives nor reasoning deltas stream. `0` disables the guard.
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Anthropic prompt-cache retention for `anthropic/…` models routed
	 * through the binding. Default `'none'` matches the current behavior (no
	 * `cache_control` markers); opt in with `'short'` (5-minute TTL) or
	 * `'long'` (1-hour TTL where supported) to cache repeated prefixes and
	 * pay the cached input rate on cache hits. Requires the agent to send a
	 * stable `sessionId` so the binding can reuse the cache across turns.
	 */
	cacheRetention?: CloudflareCacheRetention;
}

/**
 * The `cloudflare` provider: pi-ai models dispatched through the Workers AI
 * binding (`env.AI.run()`) instead of HTTP. Model metadata hydrates from
 * pi-ai's `cloudflare-workers-ai` catalog (`@cf/…` ids) and its
 * `cloudflare-ai-gateway` catalog (`anthropic/…` and `openai/…` ids); IDs
 * neither catalog knows resolve with zero metadata, since the binding accepts
 * arbitrary model IDs.
 *
 * The generated worker entry registers it when the `providers` config is
 * omitted or lists `'cloudflare'`; call `setProvider()` with this factory in
 * `app.ts` to override the gateway options (a user registration wins over
 * the generated one).
 */
export function cloudflareBindingProvider(options: CloudflareBindingProviderOptions): Provider {
	// Resolve the documented tri-state: omitted routes through Cloudflare's
	// default AI Gateway, `false` opts out, an options object replaces the
	// default.
	const gateway = options.gateway === false ? undefined : (options.gateway ?? { id: 'default' });
	const binding: CloudflareBindingStreamConfig = {
		gateway,
		streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		cacheRetention: options.cacheRetention ?? 'none',
	};
	const ai = options.binding as Ai;
	const stream = (
		model: Model<Api>,
		context: TranscriptContext,
		streamOptions?: SimpleStreamOptions,
	) => streamCloudflareWorkersAi(ai, binding, model, context, streamOptions);
	const streams: ProviderStreams = { stream, streamSimple: stream };

	const provider = createProvider<Api>({
		id: 'cloudflare',
		name: 'Cloudflare Workers AI',
		// Keyless: the binding itself is the credential.
		auth: { apiKey: { name: 'Cloudflare AI binding', resolve: async () => ({ auth: {} }) } },
		models: [...bindingCatalogModels(), ...gatewayCatalogModels()],
		api: streams,
	});
	return Object.assign(provider, {
		[DYNAMIC_MODEL_TEMPLATE]: { api: CLOUDFLARE_AI_BINDING_API, baseUrl: '' },
	});
}

/**
 * pi-ai's `cloudflare-workers-ai` catalog re-tagged for the binding: same
 * IDs and metadata, dispatched through this provider instead of the REST API.
 */
function bindingCatalogModels(): Model<Api>[] {
	return cloudflareWorkersAIProvider()
		.getModels()
		.map((model) => ({
			...model,
			api: CLOUDFLARE_AI_BINDING_API,
			provider: 'cloudflare',
			baseUrl: '',
			// Keep the catalog's per-model compat overrides (e.g. DeepSeek's
			// `requiresReasoningContentOnAssistantMessages`/`thinkingFormat`):
			// the chat-completions branch merges them over the base profile.
			// `as never` because the binding api is outside pi's compat map.
			compat: model.compat as never,
		}));
}

/**
 * pi-ai's `cloudflare-ai-gateway` catalog re-tagged for the binding. A gateway
 * catalog id is bare (`gpt-5.6-terra`) and names its vendor in the entry's
 * gateway-URL path segment (`…/{CLOUDFLARE_GATEWAY_ID}/openai`); the binding
 * addresses the same model as `openai/gpt-5.6-terra`. Models keep the
 * catalog's `api`, capabilities, and cost data. `/compat` entries are skipped:
 * they alias `@cf/…` ids the Workers AI catalog already declares.
 */
function gatewayCatalogModels(): Model<Api>[] {
	return cloudflareAIGatewayProvider()
		.getModels()
		.flatMap((model) => {
			const vendor = model.baseUrl.slice(model.baseUrl.lastIndexOf('/') + 1);
			if (vendor.length === 0 || vendor === 'compat') return [];
			return [
				{
					...model,
					id: `${vendor}/${model.id}`,
					provider: 'cloudflare',
					baseUrl: '',
				},
			];
		});
}
