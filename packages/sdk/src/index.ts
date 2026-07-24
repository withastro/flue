export type { BackoffOptions, LiveMode } from '@durable-streams/client';
// Stream errors surfaced by observation/wait iteration. These classes are
// owned by @durable-streams/client; only the ones reachable through SDK reads
// are re-exported.
export {
	DurableStreamError,
	FetchBackoffAbortError,
	FetchError,
	StreamClosedError,
} from '@durable-streams/client';
export type {
	AgentAbortResult,
	CreateFlueClientOptions,
	FlueClient,
	HttpClientOptions,
	RequestHeaders,
} from './client.ts';
export { createFlueClient } from './client.ts';
export { FlueApiError } from './http.ts';
export type {
	FlueConversationHistoryOptions,
	FlueConversationMessage,
	FlueConversationPart,
	FlueConversationSettlement,
	FlueConversationSnapshot,
	FlueConversationState,
} from './public/conversation.ts';
// The conversation `updates` wire union is not stable application API, but
// first-party presenters (the CLI) reduce it directly, so the type is
// exported for them. Application code should consume materialized
// `FlueConversationState` via `observe()` rather than handling chunks.
export type { ConversationStreamChunk } from './public/conversation-stream.ts';
export type {
	AgentConversationObservation,
	AgentConversationObservationPhase,
	AgentConversationObservationSnapshot,
	AgentConversationObserveOptions,
	ConversationLiveMode,
} from './public/observe.ts';
export type { AgentReadOptions, AgentReadResult } from './public/read.ts';
export { type AgentSubmissionReply, readSubmissionReply } from './public/reply.ts';
export type {
	AgentPromptOptions,
	AgentSendResult,
	DeliveredAttachment,
	DeliveredMessage,
} from './public/send.ts';
export {
	type AgentWaitOptions,
	FlueExecutionError,
	type FlueExecutionFailure,
	type FlueExecutionTarget,
} from './public/settle.ts';
export type { FlueEventStream, FlueStreamOptions } from './public/stream.ts';
export type { PromptUsage } from './types.ts';
