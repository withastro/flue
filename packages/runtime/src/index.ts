/// <reference path="../types/skill-md.d.ts" />

export type {
	FlueContext,
	FlueLogger,
	FlueHarness,
	FlueFs,
	FlueSessions,
	FlueSession,
	AgentHarnessOptions,
	AgentProfile,
	AgentRuntimeConfig,
	AgentCreateContext,
	CreatedAgent,
	FlueEvent,
	FlueEventCallback,
	AttachedAgentEvent,
	AttachedAgentEventCallback,
	AttachedAgentStreamError,
	SessionData,
	SessionStore,
	SessionEnv,
	FileStat,
	SandboxFactory,
	SessionToolFactory,
	SessionToolFactoryOptions,
	BashFactory,
	BashLike,
	PromptOptions,
	PromptImage,
	CallHandle,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	PromptModel,
	SkillOptions,
	TaskOptions,
	ShellOptions,
	ShellResult,
	Skill,
	SkillDefinition,
	SkillReference,
	PackagedSkillDirectory,
	PackagedSkillFile,
	SkillResources,
	SkillSource,
	SkillResourceEntry,
	AgentConfig,
	CompactionConfig,
	ModelConfig,
	ToolDefinition,
	ToolParameters,
	ThinkingLevel,
	ProviderSettings,
	AgentRouteHandler,
	AgentWebSocketHandler,
	WorkflowRouteHandler,
	WorkflowWebSocketHandler,
	WorkflowChannel,
	ChannelEventMap,
	ChannelEventContext,
	ChannelListener,
	ChannelEmitResult,
	DefinedChannel,
	ChannelOptions,
	AgentDispatchRequest,
	NamedAgentDispatchRequest,
	DispatchReceipt,
	DirectAgentPayload,
	FluePublicError,
	AgentWebSocketClientMessage,
	WorkflowWebSocketClientMessage,
	AgentWebSocketServerMessage,
	WorkflowWebSocketServerMessage,
	WebSocketErrorMessage,
	WebSocketServerMessage,
} from './types.ts';

export { Type } from '@earendil-works/pi-ai';
export { createTools, BUILTIN_TOOL_NAMES } from './agent.ts';
export { defineTool } from './tool.ts';
export { createAgent, defineAgentProfile } from './agent-definition.ts';
export { defineChannel } from './channels.ts';
export { dispatch } from './runtime/flue-app.ts';
export { http, websocket } from './workflow-channels.ts';
export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export { connectMcpServer } from './mcp.ts';
export { ResultUnavailableError } from './result.ts';
export { createSandboxSessionEnv, type SandboxApi } from './sandbox.ts';

// Note: the public Hono sub-app `flue()` and the `Fetchable` interface
// for user-authored `app.ts` entries live at `@flue/runtime/app`, not on
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
