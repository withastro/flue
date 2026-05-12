export { BUILTIN_TOOL_NAMES, createTools } from './agent.ts';

export { build, resolveSourceRoot } from './build.ts';
export {
	DEFAULT_DEV_PORT,
	type DevOptions,
	dev,
	parseEnvFiles,
	resolveEnvFiles,
} from './dev.ts';
export { ResultUnavailableError } from './result.ts';
export type {
	AgentConfig,
	AgentInfo,
	AgentInit,
	BashFactory,
	BashLike,
	BuildContext,
	BuildOptions,
	BuildPlugin,
	CallHandle,
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
	Role,
	SandboxFactory,
	SessionData,
	SessionEnv,
	SessionOptions,
	SessionStore,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	TaskOptions,
	ThinkingLevel,
	ToolDef,
	ToolParameters,
} from './types.ts';

// Note: the public Hono sub-app `flue()` and the `Fetchable` interface
// for user-authored `app.ts` entries live at `@flue/sdk/app`, not on
// the root barrel. The root re-exports build-time symbols (`build`,
// `dev`) that transitively pull in heavy dependencies (notably
// `typescript` for agent-file parsing); bundling those into a deploy
// target's runtime breaks the build (`__filename is not defined`).
// `@flue/sdk/app` is the runtime-safe path for user code; the root
// is for tooling that drives the build.
//
// Note: createFlueContext, InMemorySessionStore, bashFactoryToSessionEnv, and the
// FlueContextConfig/FlueContextInternal types are intentionally NOT re-exported
// here. They are internal runtime helpers consumed exclusively by the generated
// server entry point — see `@flue/sdk/internal`. User agent code should not
// need to import any of them directly.
