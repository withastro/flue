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

/**
 * Custom tool passed to prompt() or skill(). Scoped to the duration of the call.
 * Parameters use TypeBox schemas — import `Type` from `@flue/sdk/client`.
 */
export interface ToolDef<TParams extends TSchema = TSchema> {
	/** Must be unique across built-in and custom tools. */
	name: string;
	/** Tells the LLM when and how to use this tool. */
	description: string;
	/** TypeBox parameter schema. */
	parameters: TParams;
	/** Returns a string result sent back to the LLM. Thrown errors become tool errors. */
	execute: (args: Record<string, any>) => Promise<string>;
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
		options?: { cwd?: string; env?: Record<string, string> },
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

// ─── Agent Config (internal, passed to the harness at runtime) ──────────────

export interface AgentConfig {
	/** Discovered at runtime from AGENTS.md + .agents/skills/ in the session's cwd. */
	systemPrompt: string;
	/** Discovered at runtime from .agents/skills/ in the session's cwd. */
	skills: Record<string, Skill>;
	roles: Record<string, Role>;
	/**
	 * Agent-wide default model. Undefined by default — the user must set it via
	 * `init({ model: "provider/model-id" })` or pass `{ model }` at each prompt/
	 * skill/task call site. Calls with no model resolved throw clearly at runtime.
	 */
	model: Model<any> | undefined;
	/** Resolve a "provider/modelId" string to a Model instance. Throws on invalid input. */
	resolveModel?: (modelString: string) => Model<any>;
	compaction?: CompactionConfig;
}

// ─── Flue Context (passed to agent handlers) ───────────────────────────────

/** Request context passed to agent handler functions. */
export interface FlueContext {
	readonly id: string;
	readonly payload: any;
	/** Platform env bindings (process.env on Node, Worker env on Cloudflare). */
	readonly env: Record<string, any>;
	/** Initialize an agent runtime with sandbox + persistence. */
	init(options?: AgentInit): Promise<FlueAgent>;
}

/** All fields are optional — omitting gives platform defaults (empty sandbox, platform store, build-time model). */
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
	 * Override the default model for this agent. Applies to all prompt() and skill()
	 * calls unless overridden at the call site.
	 *
	 * Format: `'provider/modelId'` (e.g. `'anthropic/claude-opus-4-20250514'`).
	 *
	 * Precedence (highest wins): per-call `model` > role `model` > agent `model` > build-time default.
	 */
	model?: string;

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
	session(id?: string): Promise<FlueSession>;

	/** Explicit session management helpers. */
	readonly sessions: FlueSessions;

	/** Run a shell command in the agent sandbox without recording it in a conversation. */
	shell(command: string, options?: ShellOptions): Promise<ShellResult>;

	/** Destroy the agent runtime and clean up the sandbox resources it owns. */
	destroy(): Promise<void>;
}

export interface FlueSessions {
	/** Load an existing session. Throws if it does not exist. */
	get(id?: string): Promise<FlueSession>;
	/** Create a new session. Throws if it already exists. */
	create(id?: string): Promise<FlueSession>;
	/** Delete a session's stored conversation state. No-op when missing. */
	delete(id?: string): Promise<void>;
}

// ─── Flue Session ───────────────────────────────────────────────────────────

export interface FlueSession {
	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	prompt(text: string, options?: PromptOptions): Promise<PromptResponse>;

	shell(command: string, options?: ShellOptions): Promise<ShellResult>;

	skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { result: S },
	): Promise<v.InferOutput<S>>;
	skill(name: string, options?: SkillOptions): Promise<PromptResponse>;

	delete(): Promise<void>;
}

export interface PromptResponse {
	text: string;
}

// ─── Session Store ──────────────────────────────────────────────────────────

export interface SessionData {
	messages: AgentMessage[];
	metadata: Record<string, any>;
	createdAt: string;
	updatedAt: string;
	lastCompaction?: {
		summary: string;
		firstKeptIndex: number;
		details?: { readFiles: string[]; modifiedFiles: string[] };
	};
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
	| { type: 'compaction_start'; reason: 'threshold' | 'overflow'; estimatedTokens: number }
	| { type: 'compaction_end'; messagesBefore: number; messagesAfter: number }
	| { type: 'done' }
	| { type: 'error'; error: string }
) & { sessionId?: string };

export type FlueEventCallback = (event: FlueEvent) => void;

// ─── Build ──────────────────────────────────────────────────────────────────

export interface AgentInfo {
	name: string;
	filePath: string;
	triggers: { webhook?: boolean; cron?: string };
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

/** Controls the build output format for a target platform. */
export interface BuildPlugin {
	name: string;
	generateEntryPoint(ctx: BuildContext): string;
	esbuildOptions(ctx: BuildContext): Record<string, any>;
	/** Additional files to write to dist/ (e.g., wrangler.jsonc, Dockerfile). */
	additionalOutputs?(ctx: BuildContext): Record<string, string>;
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
