import type { Model, TSchema } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type * as v from 'valibot';

// ─── Skill ──────────────────────────────────────────────────────────────────

export interface Skill {
	name: string;
	description: string;
	/** Markdown body of SKILL.md (below the frontmatter). */
	instructions: string;
}

// ─── Role ───────────────────────────────────────────────────────────────────

export interface Role {
	name: string;
	description: string;
	/** Markdown body of the role file (below the frontmatter). */
	instructions: string;
	model?: string;
}

// ─── Commands (per-prompt/shell external CLI access) ────────────────────────

/**
 * An executable command that can be passed to prompt(), skill(), or shell().
 * Registered into just-bash for the duration of the call.
 */
export interface Command {
	name: string;
	execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** @deprecated Use `Command` with `defineCommand()` instead. */
export interface CommandDef {
	name: string;
	env?: Record<string, string>;
}

// ─── Custom Tools ───────────────────────────────────────────────────────────

export type ToolParameters = TSchema | Record<string, unknown>;

/**
 * Custom tool passed to init(), prompt(), skill(), or task(). init() tools are
 * available to every session call; prompt/skill/task tools are scoped to that call.
 * Parameters are JSON Schema-compatible. Use `Type` from `@flue/sdk/client` for
 * hand-written tools, or pass schemas discovered from adapters such as MCP.
 */
export interface ToolDef<TParams extends ToolParameters = ToolParameters> {
	/** Must be unique across built-in and custom tools. */
	name: string;
	/** Tells the LLM when and how to use this tool. */
	description: string;
	/** JSON Schema-compatible parameter schema. */
	parameters: TParams;
	/** Returns a string result sent back to the LLM. Thrown errors become tool errors. */
	execute: (args: Record<string, any>, signal?: AbortSignal) => Promise<string>;
}

// ─── File Stat ──────────────────────────────────────────────────────────────

export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	size: number;
	mtime: Date;
}

// ─── Session Environment ────────────────────────────────────────────────────

/**
 * Universal session environment interface. All sandbox modes (isolate, local, remote)
 * implement this — no mode-specific branching needed in core logic.
 *
 * File methods accept both absolute and relative paths (resolved against `cwd`).
 */
export interface SessionEnv {
	exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<ShellResult>;

	/** Create an operation-scoped environment, usually backed by a fresh Bash runtime. */
	scope?(options?: { commands?: Command[] }): Promise<SessionEnv>;

	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

	cwd: string;

	/**
	 * Resolve a relative path against cwd. Absolute paths pass through.
	 * File methods resolve internally — only needed when you need the absolute path
	 * for your own logic (e.g., extracting the parent directory).
	 */
	resolvePath(p: string): string;

	cleanup(): Promise<void>;
}

// ─── Compaction ─────────────────────────────────────────────────────────────

export interface CompactionConfig {
	enabled?: boolean;
	/** Token buffer to keep free in the context window. Default: 16384 */
	reserveTokens?: number;
	/** Recent tokens to preserve (not summarized). Default: 20000 */
	keepRecentTokens?: number;
}

// ─── Provider Runtime Settings ──────────────────────────────────────────────

export interface ProviderSettings {
	/**
	 * Provider endpoint used by built-in models. Useful for API gateways,
	 * LiteLLM-style proxies, or enterprise-managed provider endpoints.
	 */
	baseUrl?: string;
	/**
	 * Headers merged into the resolved model's provider-level headers. Values
	 * here override headers already defined by the built-in model.
	 */
	headers?: Record<string, string>;
	/**
	 * API key returned to the underlying agent runtime for this provider.
	 * Useful when the gateway requires a dummy key or when credentials should
	 * come from the agent's runtime env instead of process-global env vars.
	 */
	apiKey?: string;
}

export type ProvidersConfig = Record<string, ProviderSettings>;

// ─── Agent Config (internal, passed to the harness at runtime) ──────────────

export interface AgentConfig {
	/** Discovered at runtime from AGENTS.md + .agents/skills/ in the session's cwd. */
	systemPrompt: string;
	/** Discovered at runtime from .agents/skills/ in the session's cwd. */
	skills: Record<string, Skill>;
	roles: Record<string, Role>;
	/**
	 * Agent-wide default model. Undefined when the user explicitly passes
	 * `init({ model: false })`, so each model-using call must resolve one from a
	 * role or call-site override.
	 */
	model: Model<any> | undefined;
	/** Agent-wide default role. Per-session and per-call roles override this. */
	role?: string;
	/** Provider runtime settings applied when resolving models. */
	providers?: ProvidersConfig;
	/** Resolve model config to a Model instance. Throws on invalid model strings. */
	resolveModel: (model: ModelConfig | undefined, providers?: ProvidersConfig) => Model<any> | undefined;
	compaction?: CompactionConfig;
}

export type ModelConfig = string | false;

// ─── Flue Context (passed to agent handlers) ───────────────────────────────

/**
 * Request context passed to agent handler functions. Pass type parameters
 * to type `payload` and `env` (e.g. the `Env` interface generated by
 * `wrangler types`). Compile-time only — no runtime validation of `payload`.
 */
export interface FlueContext<TPayload = any, TEnv = Record<string, any>> {
	readonly id: string;
	readonly payload: TPayload;
	/** Platform env bindings (process.env on Node, Worker env on Cloudflare). */
	readonly env: TEnv;
	/**
	 * The standard Fetch `Request` for the current invocation. Use it to read
	 * headers (`req.headers.get('authorization')`), method, URL, and the
	 * raw body (`req.text()` / `req.json()` / `req.arrayBuffer()` /
	 * `req.formData()`) — useful for things like HMAC signature verification
	 * over the request bytes.
	 *
	 * Body access is single-use, like any standard `Request`: once you call a
	 * body-reading method, calling another will throw. Use `req.clone()` if
	 * you need to read it more than once.
	 *
	 * Undefined when the agent is invoked outside an HTTP context (e.g. future
	 * cron / queue triggers). Today every trigger is HTTP, so in practice this
	 * is always defined — the optional type lets the contract hold when other
	 * trigger types ship.
	 *
	 * For client IP, parse the platform header yourself, e.g.
	 * `req.headers.get('cf-connecting-ip')` on Cloudflare, or
	 * `req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` behind a
	 * trusted proxy on Node. Don't trust headers you don't control.
	 */
	readonly req: Request | undefined;
	/** Initialize an agent runtime with sandbox + persistence. */
	init(options: AgentInit): Promise<FlueAgent>;
}

/** Agent runtime options. A default model is required unless explicitly disabled with `model: false`. */
export interface AgentInit {
	/** Agent/sandbox scope id. Defaults to the route/context id. */
	id?: string;

	/** Working directory for context discovery, tools, and shell calls. Defaults to the sandbox cwd. */
	cwd?: string;

	/**
	 * - `'empty'` (default): In-memory sandbox, no files, no host access.
	 * - `'local'`: Mounts process.cwd() at /workspace. Node only.
	 * - `BashFactory`: User-configured just-bash factory. Must return a fresh Bash-like instance.
	 * - `SandboxFactory`: Connector-wrapped external sandbox (Daytona, CF Containers, etc.).
	 */
	sandbox?: 'empty' | 'local' | SandboxFactory | BashFactory;

	/** Defaults to platform store (in-memory on Node, DO SQLite on Cloudflare). */
	persist?: SessionStore;

	/**
	 * Default model for this agent. Applies to all prompt(), skill(), and task()
	 * calls unless overridden by a role or at the call site. Pass `false` to require every
	 * model-using call to resolve a model from a role or call-site override.
	 *
	 * Format: `'provider/modelId'` (e.g. `'anthropic/claude-opus-4-20250514'`).
	 *
	 * Precedence (highest wins): per-call `model` > role `model` > agent `model`.
	 */
	model: ModelConfig;

	/** Agent-wide default role. Overridden by session-level or per-call roles. */
	role?: string;

	/**
	 * Provider runtime settings for every model used by this agent, including
	 * role-level and per-call model selections.
	 *
	 * Example:
	 *
	 * ```ts
	 * await init({
	 *   model: 'anthropic/claude-sonnet-4-6',
	 *   providers: {
	 *     anthropic: {
	 *       baseUrl: env.ANTHROPIC_BASE_URL,
	 *       headers: { 'X-Custom-Auth': env.GATEWAY_KEY },
	 *       apiKey: 'dummy',
	 *     },
	 *   },
	 * });
	 * ```
	 */
	providers?: ProvidersConfig;

	/**
	 * Agent-wide tools. Every prompt(), skill(), and task() call can use these.
	 * Per-call tools are added on top and must not reuse the same names.
	 */
	tools?: ToolDef[];

	/**
	 * Agent-wide commands. Every prompt(), skill(), and shell() call inherits
	 * this list. Per-call `commands` are merged on top — if a per-call command
	 * shares a name with an agent command, the per-call version wins for that
	 * call.
	 */
	commands?: Command[];
}

// ─── Flue Agent (returned by init()) ────────────────────────────────────────

export interface FlueAgent {
	readonly id: string;

	/** Get or create a session in this agent. Defaults to the "default" session. */
	session(id?: string, options?: SessionOptions): Promise<FlueSession>;

	/** Explicit session management helpers. */
	readonly sessions: FlueSessions;

	/** Run a shell command in the agent sandbox without recording it in a conversation. */
	shell(command: string, options?: ShellOptions): Promise<ShellResult>;

	/** Destroy the agent runtime and clean up the sandbox resources it owns. */
	destroy(): Promise<void>;
}

export interface FlueSessions {
	/** Load an existing session. Throws if it does not exist. */
	get(id?: string, options?: SessionOptions): Promise<FlueSession>;
	/** Create a new session. Throws if it already exists. */
	create(id?: string, options?: SessionOptions): Promise<FlueSession>;
	/** Delete a session's stored conversation state. No-op when missing. */
	delete(id?: string): Promise<void>;
}

export interface SessionOptions {
	/** Session-wide default role. Per-call roles override this. */
	role?: string;
}

// ─── Flue Session ───────────────────────────────────────────────────────────

export interface FlueSession {
	readonly id: string;

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): Promise<PromptResponse>;

	shell(command: string, options?: ShellOptions): Promise<ShellResult>;

	skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	skill(name: string, options?: SkillOptions): Promise<PromptResponse>;

	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { result: S },
	): Promise<PromptResultResponse<v.InferOutput<S>>>;
	task(text: string, options?: TaskOptions): Promise<PromptResponse>;

	delete(): Promise<void>;
}

/**
 * Token + cost usage aggregated across every LLM call dispatched by a
 * single prompt(), skill(), or task() invocation, including:
 *   - every assistant turn produced by the call,
 *   - any result-extraction retry triggered by `result: schema` callers,
 *   - any compaction summarization (1–2 internal calls) triggered when
 *     context approached the model's window during the call,
 *   - the post-compaction retry assistant turn for overflow recovery.
 *
 * `cost` is computed by pi-ai as `(model.cost.X / 1_000_000) * usage.X`,
 * where `model.cost.X` is the per-million-token rate from the model's
 * cost table. The currency of `cost` therefore matches whatever unit that
 * rate is denominated in. For pi-ai's built-in model registry the rates
 * mirror each provider's published pricing (USD for the major commercial
 * providers); custom-registered models or proxied endpoints may use other
 * units. When in doubt, consult the active model's cost table.
 */
export interface PromptUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * Identifies the model that Flue selected for the call (after applying the
 * call > role > agent precedence). When more than one model runs during the
 * call (rare; e.g. cross-model flows), this reflects the model in effect for
 * the call's primary turn.
 */
export interface PromptModel {
	id: string;
}

export interface PromptResponse {
	text: string;
	usage: PromptUsage;
	model: PromptModel;
}

export interface PromptResultResponse<T> {
	result: T;
	usage: PromptUsage;
	model: PromptModel;
}

// ─── Session Store ──────────────────────────────────────────────────────────

export interface SessionData {
	version: 2;
	entries: SessionEntry[];
	leafId: string | null;
	metadata: Record<string, any>;
	createdAt: string;
	updatedAt: string;
}

export type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry;

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: 'message';
	message: AgentMessage;
	source?: 'prompt' | 'skill' | 'shell' | 'task' | 'retry';
}

export interface CompactionEntry extends SessionEntryBase {
	type: 'compaction';
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	/**
	 * Token usage consumed by the summarization call(s) that produced this
	 * compaction. Aggregated across the 1–2 internal LLM calls that
	 * `compact()` dispatched. Undefined for compactions persisted before
	 * this field was introduced (treated as zero by aggregators).
	 */
	usage?: PromptUsage;
}

export interface BranchSummaryEntry extends SessionEntryBase {
	type: 'branch_summary';
	fromId: string;
	summary: string;
	details?: unknown;
}

export interface SessionStore {
	save(id: string, data: SessionData): Promise<void>;
	load(id: string): Promise<SessionData | null>;
	delete(id: string): Promise<void>;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** All option fields are scoped to the duration of the call. */
export interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
	result?: S;
	timeout?: number;
	commands?: Command[];
	tools?: ToolDef[];
	role?: string;
	/** e.g., 'anthropic/claude-sonnet-4-20250514' */
	model?: string;
}

export interface SkillOptions<S extends v.GenericSchema | undefined = undefined> {
	args?: Record<string, unknown>;
	result?: S;
	timeout?: number;
	commands?: Command[];
	tools?: ToolDef[];
	role?: string;
	model?: string;
}

export interface TaskOptions<S extends v.GenericSchema | undefined = undefined> {
	result?: S;
	commands?: Command[];
	tools?: ToolDef[];
	role?: string;
	model?: string;
	/** Working directory for the detached task session. Defaults to the parent session cwd. */
	cwd?: string;
}

export interface ShellOptions {
	env?: Record<string, string>;
	cwd?: string;
	timeout?: number;
	commands?: Command[];
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

/** Wraps external sandboxes (Daytona, CF Containers, etc.) into Flue's SessionEnv. */
export interface SandboxFactory {
	createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
}

/**
 * Structural type for duck-type detection of just-bash `Bash` instances in init().
 * Purely structural — no just-bash import, so client.ts stays platform-agnostic.
 */
export interface BashLike {
	exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string> },
	): Promise<ShellResult>;
	getCwd(): string;
	fs: {
		readFile(path: string, options?: any): Promise<string>;
		readFileBuffer(path: string): Promise<Uint8Array>;
		writeFile(path: string, content: string | Uint8Array, options?: any): Promise<void>;
		stat(path: string): Promise<any>;
		readdir(path: string): Promise<string[]>;
		exists(path: string): Promise<boolean>;
		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
		resolvePath(base: string, path: string): string;
	};
	registerCommand?(cmd: any): void;
}

/** Factory for a fresh Bash-like runtime. Share `fs` inside the closure to persist files. */
export type BashFactory = () => BashLike | Promise<BashLike>;

export type FlueEvent = (
	| { type: 'agent_start' }
	| { type: 'text_delta'; text: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: any }
	| { type: 'tool_end'; toolName: string; toolCallId: string; isError: boolean; result?: any }
	| { type: 'turn_end' }
	| { type: 'command_start'; command: string; args: string[] }
	| { type: 'command_end'; command: string; exitCode: number }
	| { type: 'task_start'; taskId: string; prompt: string; role?: string; cwd?: string }
	| { type: 'task_end'; taskId: string; isError: boolean; result?: any }
	| { type: 'compaction_start'; reason: 'threshold' | 'overflow'; estimatedTokens: number }
	| { type: 'compaction_end'; messagesBefore: number; messagesAfter: number }
	| { type: 'idle' }
	| { type: 'error'; error: string }
) & { sessionId?: string; parentSessionId?: string; taskId?: string };

export type FlueEventCallback = (event: FlueEvent) => void;

// ─── Build ──────────────────────────────────────────────────────────────────

export interface AgentInfo {
	name: string;
	filePath: string;
	triggers: { webhook?: boolean };
}

export interface BuildContext {
	agents: AgentInfo[];
	roles: Record<string, Role>;
	/** The workspace root: the directory directly containing agents/ and roles/. */
	workspaceDir: string;
	/** Where dist/ is written. Typically the project root, independent of workspaceDir. */
	outputDir: string;
	options: BuildOptions;
}

/**
 * Controls the build output format for a target platform.
 *
 * A plugin can either ship a fully-bundled JavaScript artifact (Node target)
 * or hand over a TypeScript/ESM entry source that some downstream tool will
 * bundle (Cloudflare target — wrangler does the bundling). Pre-bundling on
 * top of a tool that bundles for itself causes subtle resolution conflicts
 * (we hit this with `tar`/`fs`/etc. via `nodejs_compat`), so the Cloudflare
 * path explicitly opts out.
 */
export interface BuildPlugin {
	name: string;
	/**
	 * The source of the entry point (TS or JS). May be async — the Cloudflare
	 * plugin reads the user's wrangler config (via wrangler's reader) which is
	 * a sync call but lives behind a lazy `await import('wrangler')`.
	 */
	generateEntryPoint(ctx: BuildContext): string | Promise<string>;
	/**
	 * Bundling strategy:
	 *   - `'esbuild'` (default): run the SDK's esbuild pass to produce a
	 *     bundled `dist/server.mjs`. Use when the deploy target is "just run
	 *     this file" with no further bundling step.
	 *   - `'none'`: skip esbuild. The entry is written as-is to `dist/` and
	 *     becomes the input for whatever tool will deploy it (e.g. wrangler).
	 *     The plugin must also implement `entryFilename` to set the file name.
	 */
	bundle?: 'esbuild' | 'none';
	/**
	 * The filename to use for the entry, written under `dist/`. Required when
	 * `bundle === 'none'`. For `bundle === 'esbuild'` the output is always
	 * `server.mjs` and this field is ignored.
	 */
	entryFilename?: string;
	/** esbuild options. Only consulted when `bundle === 'esbuild'`. */
	esbuildOptions?(ctx: BuildContext): Record<string, any>;
	/** Additional files to write to dist/ (e.g., wrangler.jsonc, Dockerfile). May be async. */
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}

export interface BuildOptions {
	/**
	 * The workspace directory: the directory directly containing agents/ and
	 * roles/. Pass an explicit path — no .flue/ waterfall is performed here.
	 * Callers that want the waterfall behavior (e.g. the CLI when --workspace
	 * is omitted) should resolve it themselves with `resolveWorkspaceFromCwd`.
	 */
	workspaceDir: string;
	/**
	 * Where to write the dist/ directory. Independent of workspaceDir — typically
	 * the project root, so platform config like wrangler.jsonc ends up where the
	 * deploy tool expects it.
	 */
	outputDir: string;
	target?: 'node' | 'cloudflare';
	/** Overrides `target` when provided. */
	plugin?: BuildPlugin;
}
