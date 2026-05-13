import { throwMigrationError } from './_migration.ts';
import type {
	AgentConfig,
	FlueContext,
	FlueEvent,
	FlueEventCallback,
	SessionEnv,
	SessionStore,
} from './types.ts';

throwMigrationError();

export const Type = new Proxy({}, { get: throwMigrationError, apply: throwMigrationError });
export const connectMcpServer = throwMigrationError;
export const createFlueContext = throwMigrationError;

export interface FlueContextConfig {
	id: string;
	runId: string;
	payload: any;
	env: Record<string, any>;
	agentConfig: AgentConfig;
	createDefaultEnv: () => Promise<SessionEnv>;
	createLocalEnv: () => Promise<SessionEnv>;
	defaultStore: SessionStore;
	resolveSandbox?: (sandbox: unknown) => Promise<SessionEnv> | null;
	req?: Request;
}

export interface FlueContextInternal extends FlueContext {
	emitEvent(event: FlueEvent): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	setEventCallback(callback: FlueEventCallback | undefined): void;
}

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
