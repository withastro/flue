/**
 * The GenAI vocabulary and its revision stamps live in
 * `@flue/runtime/telemetry` (single home, versioned atomically with the
 * projection); this module re-exports the revisions and layers the
 * OTel-only attribute names on top of the shared content keys.
 */
import { CONTENT_ATTR } from '@flue/runtime/telemetry';

export {
	FLUE_TELEMETRY_EXTENSION_REVISION,
	GEN_AI_PROJECTION_REVISION,
	GEN_AI_SCHEMA_URL,
	GEN_AI_SEMCONV_REVISION,
} from '@flue/runtime/telemetry';

export const ATTR = {
	operationName: 'gen_ai.operation.name',
	providerName: 'gen_ai.provider.name',
	requestModel: 'gen_ai.request.model',
	responseModel: 'gen_ai.response.model',
	responseId: 'gen_ai.response.id',
	conversationId: 'gen_ai.conversation.id',
	agentName: 'gen_ai.agent.name',
	requestStream: 'gen_ai.request.stream',
	reasoningLevel: 'gen_ai.request.reasoning.level',
	maxTokens: 'gen_ai.request.max_tokens',
	temperature: 'gen_ai.request.temperature',
	finishReasons: 'gen_ai.response.finish_reasons',
	inputTokens: 'gen_ai.usage.input_tokens',
	outputTokens: 'gen_ai.usage.output_tokens',
	cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
	cacheCreationTokens: 'gen_ai.usage.cache_creation.input_tokens',
	inputMessages: CONTENT_ATTR.inputMessages,
	outputMessages: CONTENT_ATTR.outputMessages,
	systemInstructions: CONTENT_ATTR.systemInstructions,
	toolDefinitions: CONTENT_ATTR.toolDefinitions,
	toolName: 'gen_ai.tool.name',
	toolCallId: 'gen_ai.tool.call.id',
	toolType: 'gen_ai.tool.type',
	toolDescription: CONTENT_ATTR.toolDescription,
	toolArguments: CONTENT_ATTR.toolArguments,
	toolResult: CONTENT_ATTR.toolResult,
	compacted: 'gen_ai.conversation.compacted',
	errorType: 'error.type',
	serverAddress: 'server.address',
	serverPort: 'server.port',
	openaiApiType: 'openai.api.type',
} as const;
