/// <reference path="../types/skill-md.d.ts" />

export type {
	FlueContext,
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
	SkillResources,
	SkillSource,
	SkillResourceEntry,
	AgentConfig,
	ModelConfig,
	ToolDefinition,
	ToolParameters,
	ThinkingLevel,
	ProviderSettings,
	WorkflowChannel,
	ChannelDefinition,
	ChannelWebhookHandler,
	Delivery,
	Dispatch,
	DispatchRequest,
	ReceiveContext,
	DirectAgentPayload,
	FlueAgentContext,
	FlueAgentMcp,
	FlueAgentMcpServerOptions,
	FlueAgentMcpState,
} from './types.ts';

export { Type } from '@earendil-works/pi-ai';
export { createTools, BUILTIN_TOOL_NAMES } from './agent.ts';
export { defineTool } from './tool.ts';
export { createAgent, defineAgentProfile } from './agent-definition.ts';
export { defineChannel } from './channels.ts';
export { createGitHubChannel, createGitHubChannelRouter, createGitHubWebhook, type GitHubWebhookOptions } from './github.ts';
export { http, websocket } from './workflow-channels.ts';
export type {
	McpServerConnection,
	McpServerOptions,
	McpTransport,
	McpOAuthClientProvider,
	McpAuthHook,
	McpAuthContext,
	McpAuthReason,
	RemoteMcpState,
	RemoteMcpServer,
	RemoteMcpTool,
	RemoteMcpToolResult,
	RemoteMcpConnectionState,
	McpToolProxyOptions,
} from './mcp.ts';
export { connectMcpServer, createMcpToolProxy } from './mcp.ts';
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
