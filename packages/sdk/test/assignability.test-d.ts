import {
	IMAGE_DATA_OMITTED as RUNTIME_IMAGE_DATA_OMITTED,
	type FlueEvent as RuntimeFlueEvent,
	type PromptResponse as RuntimePromptResponse,
	type PromptUsage as RuntimePromptUsage,
} from '@flue/runtime';
import {
	IMAGE_DATA_OMITTED as SDK_IMAGE_DATA_OMITTED,
	type AgentPromptResponse,
	type FlueEvent as SdkFlueEvent,
	type PromptUsage as SdkPromptUsage,
} from '../src/index.ts';

// `turn_request` is in-process only (`observe()` subscribers and exporters);
// it is never persisted to durable streams or served over HTTP, so the SDK
// wire union deliberately omits it.
const _: SdkFlueEvent = {} as Exclude<RuntimeFlueEvent, { type: 'turn_request' }>;
void _;

// Direct-agent prompts (`?wait=result`) always resolve with the runtime
// `PromptResponse`; the SDK duplicates the shape so it must stay assignable.
const _prompt: AgentPromptResponse = {} as RuntimePromptResponse;
void _prompt;

// The SDK duplicates `PromptUsage`; the shapes must stay mutually assignable.
const _usage: SdkPromptUsage = {} as RuntimePromptUsage;
const _usageBack: RuntimePromptUsage = {} as SdkPromptUsage;
void _usage;
void _usageBack;

// The SDK duplicates the image-redaction sentinel; both constants are literal
// string types, so these assignments fail if the values ever diverge.
const _sentinel: typeof RUNTIME_IMAGE_DATA_OMITTED = SDK_IMAGE_DATA_OMITTED;
const _sentinelBack: typeof SDK_IMAGE_DATA_OMITTED = RUNTIME_IMAGE_DATA_OMITTED;
void _sentinel;
void _sentinelBack;
