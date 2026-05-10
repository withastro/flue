export type {
	FlueContext,
	FlueHarness,
	FlueFs,
	FlueSessions,
	FlueSession,
	AgentInit,
	FlueEvent,
	FlueEventCallback,
	SessionData,
	SessionDelta,
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
	BuildPlugin,
	BuildContext,
	AgentInfo,
	ToolDef,
	ToolParameters,
	ThinkingLevel,
} from './types.ts';

export { build, resolveSourceRoot } from './build.ts';
export {
	dev,
	DEFAULT_DEV_PORT,
	resolveEnvFiles,
	parseEnvFiles,
	type DevOptions,
} from './dev.ts';
export { createTools, BUILTIN_TOOL_NAMES } from './agent.ts';
export { ResultUnavailableError } from './result.ts';

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
