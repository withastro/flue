throw new Error(
	'[@flue/runtime] The @flue/runtime/client entrypoint has been folded into the root @flue/runtime export. ' +
		'Update imports from "@flue/runtime/client" to "@flue/runtime". ' +
		'See the changelog: https://github.com/withastro/flue/blob/main/CHANGELOG.md#unreleased',
);

// Preserve the old type surface for one release so TypeScript users get the
// runtime migration error instead of a less helpful "module has no export".
export { Type } from '@mariozechner/pi-ai';
export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';
export { connectMcpServer } from './mcp.ts';
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
