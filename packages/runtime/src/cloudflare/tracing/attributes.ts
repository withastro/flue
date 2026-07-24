/**
 * Attribute keys for the native Cloudflare tracing adapter.
 *
 * `gen_ai.*` keys follow the OpenTelemetry GenAI semantic conventions where
 * they exist (Development status — centralizing them here keeps spec churn a
 * one-file edit; none of these constants are exported from the package). The
 * key set deliberately mirrors `@flue/opentelemetry`'s projection so a Flue
 * agent reads the same across OTel backends and the Cloudflare dashboard —
 * restricted to the scalar subset Workers `Span.setAttribute` accepts
 * (array-typed keys like `gen_ai.response.finish_reasons` are omitted rather
 * than JSON-encoded under an array-typed name).
 *
 * Flue-specific keys live under `flue.*`. The `cloudflare.agents.*` namespace
 * belongs to Cloudflare's agents SDK and is not emitted here.
 */
export const ATTR = {
	operationName: 'gen_ai.operation.name',
	providerName: 'gen_ai.provider.name',
	requestModel: 'gen_ai.request.model',
	responseModel: 'gen_ai.response.model',
	responseId: 'gen_ai.response.id',
	conversationId: 'gen_ai.conversation.id',
	agentName: 'gen_ai.agent.name',
	agentId: 'gen_ai.agent.id',
	requestStream: 'gen_ai.request.stream',
	reasoningLevel: 'gen_ai.request.reasoning.level',
	maxTokens: 'gen_ai.request.max_tokens',
	temperature: 'gen_ai.request.temperature',
	inputTokens: 'gen_ai.usage.input_tokens',
	outputTokens: 'gen_ai.usage.output_tokens',
	cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
	cacheCreationTokens: 'gen_ai.usage.cache_creation.input_tokens',
	toolName: 'gen_ai.tool.name',
	toolCallId: 'gen_ai.tool.call.id',
	toolType: 'gen_ai.tool.type',
	errorType: 'error.type',
} as const;

export const FLUE_ATTR = {
	submissionId: 'flue.submission.id',
	operationKind: 'flue.operation.kind',
	taskId: 'flue.task.id',
	toolOrigin: 'flue.tool.origin',
	turnPurpose: 'flue.turn.purpose',
	finishReason: 'flue.response.finish_reason',
	usageTotalTokens: 'flue.usage.total_tokens',
	/** Recognized cancellation — a control path, never counted as an error. */
	canceled: 'flue.canceled',
} as const;
