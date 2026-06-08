/// <reference path="../types/skill-md.d.ts" />
/// <reference path="../types/markdown-md.d.ts" />

export { Type } from '@earendil-works/pi-ai';
export type { PersistenceAdapter } from './agent-execution-store.ts';
export { createAgent, defineAgentProfile } from './agent-definition.ts';
export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export { connectMcpServer } from './mcp.ts';
export { ResultUnavailableError } from './result.ts';
export { type FlueEventSubscriber, observe } from './runtime/events.ts';
export { dispatch } from './runtime/flue-app.ts';
export {
	configureProvider,
	type HttpProviderRegistration,
	type ProviderRegistration,
	registerApiProvider,
	registerProvider,
} from './runtime/providers.ts';
export { createSandboxSessionEnv, type SandboxApi } from './sandbox.ts';
export { defineTool } from './tool.ts';
export type {
	AgentCreateContext,
	AgentDispatchRequest,
	DurabilityConfig,
	AgentHarnessOptions,
	AgentProfile,
	AgentRouteHandler,
	AgentRuntimeConfig,
	AgentWebSocketClientMessage,
	AgentWebSocketHandler,
	AgentWebSocketServerMessage,
	AttachedAgentEvent,
	AttachedAgentStreamError,
	BashFactory,
	BashLike,
	CallHandle,
	CompactionConfig,
	CreatedAgent,
	DispatchReceipt,
	FileStat,
	FlueContext,
	FlueEvent,
	FlueFs,
	FlueHarness,
	FlueLogger,
	FluePublicError,
	FlueSession,
	FlueSessions,
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
	ModelConfig,
	NamedAgentDispatchRequest,
	PackagedSkillDirectory,
	PackagedSkillFile,
	PromptImage,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	ProviderConfiguration,
	SandboxFactory,
	SessionData,
	SessionEnv,
	SessionStore,
	SessionToolFactory,
	SessionToolFactoryOptions,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	SkillReference,
	TaskOptions,
	ThinkingLevel,
	ToolDefinition,
	ToolParameters,
	WebSocketErrorMessage,
	WebSocketServerMessage,
	WorkflowRouteHandler,
	WorkflowRunWebSocketErrorMessage,
	WorkflowWebSocketClientMessage,
	WorkflowWebSocketHandler,
	WorkflowWebSocketServerMessage,
} from './types.ts';

// Note: the public Hono sub-app `flue()` and the `Fetchable` interface
// for user-authored `app.ts` entries live at `@flue/runtime/routing`, not on
// the root barrel.
//
// Note: createFlueContext, InMemorySessionStore, bashFactoryToSessionEnv, and the
// FlueContextConfig/FlueContextInternal types are intentionally NOT re-exported
// here. They are internal runtime helpers consumed exclusively by the generated
// server entry point — see `@flue/runtime/internal`. User agent code should not
// need to import any of them directly.
//
// Note: `build`, `dev`, and the build/dev/env helpers used to be re-exported
// from this barrel when the package was `@flue/sdk`. They moved into
// `@flue/cli` when build tooling was extracted from the runtime. Import them
// from `@flue/cli` if you're driving the build programmatically.
