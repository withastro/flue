import { throwMigrationError } from './_migration.ts';

throwMigrationError();

export const Type = new Proxy({}, { get: throwMigrationError, apply: throwMigrationError });
export const connectMcpServer = throwMigrationError;

export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export type {
	AgentInit,
	BashFactory,
	BashLike,
	FileStat,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	FlueFs,
	FlueHarness,
	FlueSession,
	FlueSessions,
	ModelConfig,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	ProviderSettings,
	SandboxFactory,
	SessionData,
	SessionEnv,
	SessionOptions,
	SessionStore,
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
	ThinkingLevel,
	ToolDef,
	ToolParameters,
} from './types.ts';
