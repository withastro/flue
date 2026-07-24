/// <reference path="../types/skill-md.d.ts" />
/// <reference path="../types/markdown-md.d.ts" />

// The standard model-facing tools, one factory per tool. Compose them in a
// SandboxFactory's `tools` list to add, drop, or swap tools without
// rebuilding the set; omit `tools` entirely for the framework default.
export {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
} from './agent.ts';
export {
	type AgentHandleDispatchRequest,
	type AgentInstanceHandle,
	type AgentReadOptions,
	type AgentReply,
	AgentRunError,
	type InitOptions,
	init,
} from './agent-client.ts';
// The live conversation projection protocol (`init().read`'s onEvent, the
// SDK's updates view). The canonical record schema stays internal.
export type { ConversationStreamChunk } from './conversation-public.ts';
export {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	AttachmentNotAvailableError,
	DelegationDepthExceededError,
	FlueError,
	InstrumentationAlreadyInstalledError,
	OperationFailedError,
	SandboxDiedError,
	SandboxOperationUnsupportedError,
	SessionBusyError,
	SessionNotFoundError,
	SkillDefinitionValidationError,
	SkillNotRegisteredError,
	SubagentNotDeclaredError,
	SubmissionAbortedError,
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
	ToolInputValidationError,
	ToolNameConflictError,
	ToolOutputSerializationError,
	ToolOutputValidationError,
	type ToolValidationIssue,
	type ValidationIssue,
} from './errors.ts';
export { IMAGE_DATA_OMITTED } from './event-redaction.ts';
export type {
	FlueExecutionContext,
	FlueExecutionInterceptor,
	FlueExecutionOperation,
} from './execution-interceptor.ts';
export { useAgentFinish } from './hooks/use-agent-finish.ts';
export { useAgentStart } from './hooks/use-agent-start.ts';
export { useDataWriter } from './hooks/use-data-writer.ts';
export { useDelivery } from './hooks/use-delivery.ts';
export { useDispatchMessage } from './hooks/use-dispatch-message.ts';
export { useInitialData } from './hooks/use-initial-data.ts';
export { useInstruction } from './hooks/use-instruction.ts';
export { defineMcpConnection, useMcpConnection } from './hooks/use-mcp-connection.ts';
export { type UseModelOptions, useModel } from './hooks/use-model.ts';
export { type StateSetter, usePersistentState } from './hooks/use-persistent-state.ts';
export { useResponseFinish } from './hooks/use-response-finish.ts';
export { useResponseStart } from './hooks/use-response-start.ts';
export { type UseSandboxOptions, useSandbox } from './hooks/use-sandbox.ts';
export { useSkill } from './hooks/use-skill.ts';
export { defineSubagent, GeneralSubagent, useSubagent } from './hooks/use-subagent.ts';
export { useTool } from './hooks/use-tool.ts';
export { type FlueInstrumentation, instrument } from './instrumentation.ts';
export type { JsonValue } from './json-snapshot.ts';
export type { McpAuth, McpConnection, McpConnectionDefinition, McpTransport } from './mcp.ts';
export { createMcpConnection } from './mcp.ts';
export type {
	AgentAppendMessage,
	AgentFinishContext,
	AgentResponseToolCall,
	AgentSignalAppend,
	AgentStartContext,
	ResponseFinishContext,
	ResponseMetadataCallback,
	ResponseStartContext,
} from './message-output.ts';
export type { FlueObservationSubscriber } from './observation.ts';
export { ResultUnavailableError } from './result.ts';
export type { ChannelRouteDefinition } from './runtime/channel-routes.ts';
export { createChannelRouter } from './runtime/channel-routes.ts';
export { type FlueEventSubscriber, observe } from './runtime/events.ts';
export { type AgentInstanceInfo, dispatch, getAgentInstance } from './runtime/flue-app.ts';
export { setProvider } from './runtime/providers.ts';
export type { AgentIdentityBinding } from './runtime/registration.ts';
export { __flueBindAgentModule } from './runtime/registration.ts';
export { bash, createSandboxSessionEnv, type SandboxApi } from './sandbox.ts';
export { defineSkill } from './skill-definition.ts';
export { defineTool } from './tool.ts';
export type {
	Agent,
	AgentDispatchRequest,
	AgentFunction,
	AgentProps,
	AgentRuntimeConfig,
	AgentStatics,
	AttachedAgentEvent,
	BashFactory,
	BashLike,
	CallHandle,
	CompactionConfig,
	DeliveredAttachment,
	DeliveredMessage,
	DeliveredMessageInput,
	DispatchReceipt,
	DurabilityConfig,
	FileStat,
	FlueEvent,
	FlueEventContext,
	FlueFs,
	FlueHarness,
	FlueLogger,
	FlueObservation,
	LlmAssistantMessage,
	LlmImageContent,
	LlmMessage,
	LlmTextContent,
	LlmThinkingContent,
	LlmTool,
	LlmToolCall,
	LlmToolResultMessage,
	LlmTurnPurpose,
	LlmUserMessage,
	ModelRequest,
	ModelRequestInfo,
	ModelRequestInput,
	ModelResponse,
	PackagedSkillDirectory,
	PackagedSkillFile,
	PromptImage,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
	SessionToolFactoryOptions,
	ShellOptions,
	ShellResult,
	Skill,
	SkillDefinition,
	SkillOptions,
	SkillReference,
	SubagentDefinition,
	TaskOptions,
	ThinkingLevel,
	ToolContext,
	ToolDefinition,
	ToolInput,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
	ToolStep,
} from './types.ts';

// Note: the `Fetchable` interface for user-authored `app.ts` entries lives at
// `@flue/runtime/routing`, not on the root barrel.
//
// Note: createFlueContext, bashFactoryToSessionEnv, and the
// FlueContextConfig/FlueContextInternal types are intentionally NOT re-exported
// here. They are internal runtime helpers consumed exclusively by the generated
// server entry point — see `@flue/runtime/internal`. User agent code should not
// need to import any of them directly.
//
// Note: `build`, `dev`, and the build/dev/env helpers live in `@flue/cli`,
// not this barrel — import them from there if you're driving the build
// programmatically.
