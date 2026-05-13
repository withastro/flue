import { throwMigrationError } from './_migration.ts';
import type { BuiltinToolName } from './types.ts';

throwMigrationError();

export type {
	FlueContext,
	FlueHarness,
	FlueFs,
	FlueSessions,
	FlueSession,
	AgentInit,
	FlueEvent,
	FlueEventCallback,
	BuiltinToolName,
	SessionData,
	SessionStore,
	SessionEnv,
	FileStat,
	SandboxFactory,
	BashFactory,
	BashLike,
	SessionOptions,
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
	Role,
	AgentConfig,
	ModelConfig,
	BuildOptions,
	DevOptions,
	BuildPlugin,
	BuildContext,
	AgentInfo,
	ToolDef,
	ToolParameters,
	ThinkingLevel,
} from './types.ts';

export const build = throwMigrationError;
export const resolveSourceRoot = throwMigrationError;
export const dev = throwMigrationError;
export const resolveEnvFiles = throwMigrationError;
export const parseEnvFiles = throwMigrationError;
export const createTools = throwMigrationError;
export const ResultUnavailableError = Error;
export const BUILTIN_TOOL_NAMES = [
	'read',
	'write',
	'edit',
	'bash',
	'grep',
	'glob',
	'task',
] as const satisfies readonly BuiltinToolName[];
export const DEFAULT_DEV_PORT = 3583;
