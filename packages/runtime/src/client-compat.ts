throw new Error(
	'[@flue/runtime] The @flue/runtime/client entrypoint has been folded into the root @flue/runtime export. ' +
		'Update imports from "@flue/runtime/client" to "@flue/runtime". ' +
		'See the changelog: https://github.com/withastro/flue/blob/main/CHANGELOG.md#unreleased',
);

// Keep current type exports available on this deprecated path so editors can
// guide users toward the root export without preserving removed APIs.
export { Type } from '@earendil-works/pi-ai';
export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export { connectMcpServer } from './mcp.ts';
export type {
	AgentProfile,
	AgentRuntimeConfig,
	AgentCreateContext,
	CreatedAgent,
	BashFactory,
	BashLike,
	FileStat,
	FlueContext,
	FlueLogger,
	FlueEvent,
	FlueFs,
	FlueHarness,
	FlueSession,
	FlueSessions,
	CompactionConfig,
	ModelConfig,
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
	ShellOptions,
	ShellResult,
	SkillOptions,
	TaskOptions,
	ThinkingLevel,
	ToolDefinition,
	ToolParameters,
} from './types.ts';
