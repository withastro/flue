import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ImageContent, Model, TSchema } from '@mariozechner/pi-ai';
import type * as v from 'valibot';


export type { ThinkingLevel };

/**
 * Inline image content attached to a `prompt()`, `skill()`, or `task()` call.
 * Re-exports pi-ai's `ImageContent` shape: `{ type: 'image', data: base64, mimeType }`.
 * The selected model must support vision input.
 */
export type PromptImage = ImageContent;

// ─── Skill ──────────────────────────────────────────────────────────────────

/**
 * A skill registered with the session. The body of the skill (everything
 * below the frontmatter in `SKILL.md`) is intentionally NOT cached in
 * memory — at call time, the model reads the file from disk via its
 * filesystem tools. That keeps relative references inside the skill
 * resolvable from where they live, and lets users edit skill files
 * mid-session without re-initialising the agent.
 */
export interface Skill {
	name: string;
	description: string;
}

// ─── Role ───────────────────────────────────────────────────────────────────

export interface Role {
	name: string;
	description: string;
	/** Markdown body of the role file (below the frontmatter). */
	instructions: string;
	model?: string;
	/**
	 * Reasoning effort to apply to model calls performed under this role. Forwarded
	 * to pi-ai's `SimpleStreamOptions.reasoning`. Models without reasoning support
	 * silently ignore it. Pi-ai clamps the requested level against
	 * `Model.thinkingLevelMap` per provider. Use `"off"` to explicitly disable.
	 */
	thinkingLevel?: ThinkingLevel;
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
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			/**
			 * Wall-clock deadline hint in seconds. Forwarded to the underlying
			 * sandbox connector's native timeout option (E2B `timeoutMs`,
			 * Daytona `timeout`, etc.) so signal-blind providers still observe
			 * the deadline with full fidelity.
			 *
			 * Independent of `signal`. Callers that have a deadline AND want
			 * mid-flight cancellation should pass both: `timeout` for
			 * provider-native enforcement, `signal` for ad-hoc abort. The
			 * bash tool does this when the model emits a `timeout` parameter.
			 */
			timeout?: number;
			/**
			 * Cancel the in-flight command. Aborting rejects with an
			 * `AbortError`. Connectors that wrap a signal-aware SDK observe
			 * this mid-flight; others see it only before/after the remote
			 * call returns. Use `timeout` for guaranteed deadline enforcement
			 * on signal-blind connectors.
			 */
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;

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
}

/**
 * Filesystem surface for the harness sandbox, exposed on `FlueHarness.fs` and
 * `FlueSession.fs`. Reads and writes happen inside whatever the sandbox
 * connector points at (a remote container, microVM, in-process FS, etc.).
 *
 * Operations are out-of-band — they don't appear in the conversation
 * transcript. The model has its own `read`/`write`/`edit` tools for
 * filesystem work it should reason about. Use `fs` for plumbing (staging
 * files, capturing artifacts, managing scratch space) the model shouldn't
 * see. If a write should feed into the model's next turn, prompt the model
 * to read the file itself.
 *
 * Paths can be absolute or relative. Relative paths are resolved against
 * the agent's cwd, which comes from `init({ cwd })` if set, otherwise from
 * the sandbox connector's default (varies by provider). Use absolute paths
 * for portability across connectors.
 */
export interface FlueFs {
	/** Read a UTF-8 file. Throws if the path doesn't exist or isn't a file. */
	readFile(path: string): Promise<string>;

	/** Read a file as raw bytes. Use this for binary content. */
	readFileBuffer(path: string): Promise<Uint8Array>;

	/**
	 * Write content to a file. Creates the file if it doesn't exist; replaces
	 * it if it does. Accepts both UTF-8 strings and raw bytes.
	 */
	writeFile(path: string, content: string | Uint8Array): Promise<void>;

	/** Get file metadata (size, mtime, type). Throws if the path doesn't exist. */
	stat(path: string): Promise<FileStat>;

	/** List directory entries (names only, no paths). Throws if not a directory. */
	readdir(path: string): Promise<string[]>;

	/** True if a file or directory exists at `path`. Never throws. */
	exists(path: string): Promise<boolean>;

	/**
	 * Create a directory. Pass `{ recursive: true }` to create parent
	 * directories as needed (mkdir -p semantics).
	 */
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

	/**
	 * Remove a file or directory. Pass `{ recursive: true }` to remove
	 * directory trees, `{ force: true }` to suppress missing-path errors.
	 */
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
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

/** Per-provider transport settings configured from `@flue/sdk/app`. */
export interface ProviderSettings {
	/** Provider endpoint used by built-in models or registered providers. */
	baseUrl?: string;
	/** Headers merged into the resolved model's provider-level headers. */
	headers?: Record<string, string>;
	/** API key returned to the underlying harness runtime for this provider. */
	apiKey?: string;
	/**
	 * Sends `store: true` for OpenAI Responses API providers. Only enable when
	 * you need OpenAI-hosted item persistence and accept its retention policy.
	 */
	storeResponses?: boolean;
}

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
	/** Resolve model config to a Model instance. Throws on invalid model strings. */
	resolveModel: (model: ModelConfig | undefined) => Model<any> | undefined;
	/**
	 * Agent-wide default reasoning effort. Per-call and role-level values
	 * override this. The harness substitutes `"medium"` when unset; see
	 * `AgentInit.thinkingLevel` for the full precedence rules.
	 */
	thinkingLevel?: ThinkingLevel;
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
	/** Agent instance id from the URL `<id>` segment. */
	readonly id: string;
	/** Server-minted id for this HTTP invocation. */
	readonly runId: string;
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
	/** Emit structured log events visible in the run event stream. */
	readonly log: FlueLogger;
	/** Initialize a harness with sandbox + persistence. */
	init(options: AgentInit): Promise<FlueHarness>;
}

export interface FlueLogger {
	info(message: string, attributes?: Record<string, unknown>): void;
	warn(message: string, attributes?: Record<string, unknown>): void;
	error(message: string, attributes?: Record<string, unknown>): void;
}

/** Harness options. A default model is required unless explicitly disabled with `model: false`. */
export interface AgentInit {
	/** Harness name. Defaults to `"default"`. */
	name?: string;

	/** Working directory for context discovery, tools, and shell calls. Defaults to the sandbox cwd. */
	cwd?: string;

	/**
	 * - `'empty'` (default): In-memory sandbox, no files, no host access.
	 * - `'local'`: No sandbox — direct access to the host filesystem and shell.
	 *   `cwd` defaults to `process.cwd()`. Node target only; throws on Cloudflare.
	 *   Use this when flue itself is running inside an external sandbox / container
	 *   / CI runner that already provides the isolation boundary.
	 * - `BashFactory`: User-configured just-bash factory. Called once to construct the runtime.
	 * - `SandboxFactory`: Connector-wrapped external sandbox (Daytona, CF Containers, etc.).
	 */
	sandbox?: 'empty' | 'local' | SandboxFactory | BashFactory;

	/** Defaults to platform store (in-memory on Node, DO SQLite on Cloudflare). */
	persist?: SessionStore;

	/**
	 * Default model for this harness. Applies to all prompt(), skill(), and task()
	 * calls unless overridden by a role or at the call site. Pass `false` to require every
	 * model-using call to resolve a model from a role or call-site override.
	 *
	 * Format: `'provider/modelId'` (e.g. `'anthropic/claude-opus-4-20250514'`).
	 *
	 * Precedence (highest wins): per-call `model` > role `model` > harness `model`.
	 */
	model: ModelConfig;

	/** Harness-wide default role. Overridden by session-level or per-call roles. */
	role?: string;

	/**
	 * Default reasoning effort for every prompt(), skill(), and task() call.
	 * Forwarded to pi-ai's `SimpleStreamOptions.reasoning`. Pi-ai clamps the
	 * requested level against the model's `thinkingLevelMap`; non-reasoning
	 * models effectively run with reasoning off after clamping.
	 *
	 * Precedence (highest wins): per-call `thinkingLevel` > role
	 * `thinkingLevel` > harness `thinkingLevel`. When nothing is set, the harness
	 * defaults to `"medium"`. Use `"off"` to explicitly disable reasoning on
	 * models that support it.
	 */
	thinkingLevel?: ThinkingLevel;

	/**
	 * Harness-wide tools. Every prompt(), skill(), and task() call can use these.
	 * Per-call tools are added on top and must not reuse the same names.
	 */
	tools?: ToolDef[];
}

// ─── Flue Harness (returned by init()) ──────────────────────────────────────

export interface FlueHarness {
	readonly name: string;

	/** Get or create a session in this harness. Defaults to the "default" session. */
	session(name?: string, options?: SessionOptions): Promise<FlueSession>;

	/** Explicit session management helpers. */
	readonly sessions: FlueSessions;

	/** Run a shell command in the harness sandbox without recording it in a conversation. */
	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;

	/**
	 * Read and write files in the harness sandbox without recording in a
	 * conversation. See {@link FlueFs}.
	 */
	readonly fs: FlueFs;
}

export interface FlueSessions {
	/** Load an existing session. Throws if it does not exist. */
	get(name?: string, options?: SessionOptions): Promise<FlueSession>;
	/** Create a new session. Throws if it already exists. */
	create(name?: string, options?: SessionOptions): Promise<FlueSession>;
	/** Delete a session's stored conversation state. No-op when missing. */
	delete(name?: string): Promise<void>;
}

export interface SessionOptions {
	/** Session-wide default role. Per-call roles override this. */
	role?: string;
}

// ─── Flue Session ───────────────────────────────────────────────────────────

/**
 * Awaitable handle returned by `prompt()`, `skill()`, `task()`, and `shell()`.
 * Aborting rejects the awaited value with an `AbortError` (a `DOMException`)
 * whose `cause` is the signal's `reason`. Pass `options.signal` to merge an
 * external `AbortSignal` (e.g. `AbortSignal.timeout(ms)`) with the handle's.
 */
export interface CallHandle<T> extends PromiseLike<T> {
	/** Fires when the call is aborted, whether via `abort()` or `options.signal`. */
	readonly signal: AbortSignal;
	/** Cancel the in-flight call. */
	abort(reason?: unknown): void;
}

export interface FlueSession {
	readonly name: string;

	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { schema: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;

	/**
	 * Read and write files in the session's sandbox. See {@link FlueFs}.
	 * Unlike {@link FlueSession.shell}, fs operations are not recorded in
	 * the conversation transcript.
	 */
	readonly fs: FlueFs;

	skill<S extends v.GenericSchema>(
		name: string,
		options: SkillOptions<S> & { schema: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(name: string, options?: SkillOptions): CallHandle<PromptResponse>;

	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { schema: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;

	delete(): Promise<void>;
}

/**
 * Token + cost usage aggregated across every LLM call dispatched by a
 * single prompt(), skill(), or task() invocation, including:
 *   - every assistant turn produced by the call,
 *   - any result-extraction retry triggered by `schema:` callers,
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
	data: T;
	/**
	 * @deprecated Renamed to `data`; will be removed in a future release.
	 * The runtime still populates this field, but it is typed as `never` so
	 * TypeScript flags any usage. Migrate destructures from
	 * `{ result }` to `{ data }`.
	 */
	result?: never;
	usage: PromptUsage;
	model: PromptModel;
}

// ─── Session Store ──────────────────────────────────────────────────────────

export interface SessionData {
	version: 3;
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

/**
 * Delta passed to `SessionStore.saveDelta?`. Contains the entries appended
 * since the last successful save, any entries removed from the current
 * `SessionData`, and the current session header fields as full overwrites.
 *
 * Most history changes are append-only: compaction and branch summaries push
 * new entries without mutating older ones. Overflow recovery is the exception:
 * the SDK may remove a failed assistant leaf before retrying. Adapters must
 * apply `removedEntryIds` before appending `newEntries` so `load()` returns
 * the latest authoritative `SessionData`, not the union of all entries ever
 * seen.
 */
export interface SessionDelta {
	/** Session data version. Matches `SessionData.version`. */
	version: SessionData['version'];
	/** Entries appended since the last save call (in order). */
	newEntries: SessionEntry[];
	/** Entry ids removed from the current session since the last save. */
	removedEntryIds: string[];
	/** Current leaf id (full overwrite). */
	leafId: string | null;
	/** Current metadata (full overwrite — small object). */
	metadata: Record<string, any>;
	/** Session creation timestamp (full overwrite). */
	createdAt: string;
	/** Session update timestamp for this save (full overwrite). */
	updatedAt: string;
}

export interface SessionStore {
	save(id: string, data: SessionData): Promise<void>;
	load(id: string): Promise<SessionData | null>;
	delete(id: string): Promise<void>;

	/**
	 * Optional delta hook. If implemented, it is called by live `Session`
	 * instances *instead of* `save()` with only the entry changes since the
	 * last successful save. Adapters that implement this can persist O(delta)
	 * per turn instead of O(history).
	 *
	 * Dispatch is checked per call via `typeof store.saveDelta === 'function'`,
	 * so adapters that implement both methods will only see `saveDelta` invoked
	 * for live session saves. `save()` remains required: Flue still uses it for
	 * initial empty session creation and for adapters that don't opt in.
	 *
	 * `load(id)` must still return the full `SessionData` — the adapter is
	 * responsible for reconstructing it from its records.
	 *
	 * When a session is resumed from `load()`, pre-existing entries are treated
	 * as already saved; the first `saveDelta` carries only changes made after
	 * construction. When `load()` returns null, Flue first writes an empty
	 * `SessionData` via `save()`, then later `saveDelta` calls carry entries
	 * appended after that empty snapshot.
	 *
	 * `newEntries.length === 0` is possible (a `save()` call with nothing to
	 * append) and adapters should still apply `removedEntryIds` plus the
	 * `leafId`/`metadata`/timestamp refresh. Empty `newEntries` is never a
	 * signal to delete all prior entries.
	 */
	saveDelta?(id: string, delta: SessionDelta): Promise<void>;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** All option fields are scoped to the duration of the call. */
export interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
	schema?: S;
	/**
	 * @deprecated Renamed to `schema`; will be removed in a future release.
	 * The runtime still accepts this field, but it is typed as `never` so
	 * TypeScript flags any usage. Migrate `result: <schema>` to
	 * `schema: <schema>`.
	 */
	result?: never;
	tools?: ToolDef[];
	role?: string;
	/** e.g., 'anthropic/claude-sonnet-4-20250514' */
	model?: string;
	/** Override reasoning effort for this call. See `AgentInit.thinkingLevel`. */
	thinkingLevel?: ThinkingLevel;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
	/** Images attached to this user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

export interface SkillOptions<S extends v.GenericSchema | undefined = undefined> {
	args?: Record<string, unknown>;
	schema?: S;
	/**
	 * @deprecated Renamed to `schema`; will be removed in a future release.
	 * The runtime still accepts this field, but it is typed as `never` so
	 * TypeScript flags any usage. Migrate `result: <schema>` to
	 * `schema: <schema>`.
	 */
	result?: never;
	tools?: ToolDef[];
	role?: string;
	model?: string;
	/** Override reasoning effort for this call. See `AgentInit.thinkingLevel`. */
	thinkingLevel?: ThinkingLevel;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
	/** Images attached to the skill's user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

export interface TaskOptions<S extends v.GenericSchema | undefined = undefined> {
	schema?: S;
	/**
	 * @deprecated Renamed to `schema`; will be removed in a future release.
	 * The runtime still accepts this field, but it is typed as `never` so
	 * TypeScript flags any usage. Migrate `result: <schema>` to
	 * `schema: <schema>`.
	 */
	result?: never;
	tools?: ToolDef[];
	role?: string;
	model?: string;
	/** Override reasoning effort for this call. See `AgentInit.thinkingLevel`. */
	thinkingLevel?: ThinkingLevel;
	/** Working directory for the detached task session. Defaults to the parent session cwd. */
	cwd?: string;
	/** Cancel this task. See `CallHandle`. */
	signal?: AbortSignal;
	/** Images attached to the task's initial user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

export interface ShellOptions {
	env?: Record<string, string>;
	cwd?: string;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
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
		options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
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
}

/** Factory that constructs the agent's Bash-like runtime. Called once at init. */
export type BashFactory = () => BashLike | Promise<BashLike>;

export type FlueEvent = (
	| {
			type: 'run_start';
			runId: string;
			instanceId: string;
			agentName: string;
			startedAt: string;
			payload: unknown;
		}
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start' }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'thinking_end'; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: any }
	| {
			type: 'tool_call';
			toolName: string;
			toolCallId: string;
			isError: boolean;
			result?: any;
			durationMs: number;
		}
	| {
			type: 'turn';
			durationMs: number;
			model?: string;
			usage?: PromptUsage;
			stopReason?: string;
			isError: boolean;
			error?: unknown;
		}
	| { type: 'task_start'; taskId: string; prompt: string; role?: string; cwd?: string }
	| { type: 'task'; taskId: string; isError: boolean; result?: any; durationMs: number }
	| { type: 'compaction_start'; reason: 'threshold' | 'overflow'; estimatedTokens: number }
	| { type: 'compaction'; messagesBefore: number; messagesAfter: number; durationMs: number; usage?: PromptUsage }
	| { type: 'operation_start'; operationId: string; operationKind: 'prompt' | 'skill' | 'task' | 'shell' }
	| {
			type: 'operation';
			operationId: string;
			operationKind: 'prompt' | 'skill' | 'task' | 'shell';
			durationMs: number;
			isError: boolean;
			error?: unknown;
			result?: unknown;
			usage?: PromptUsage;
		}
	| {
			type: 'log';
			level: 'info' | 'warn' | 'error';
			message: string;
			attributes?: Record<string, unknown>;
		}
	| { type: 'idle' }
	| { type: 'run_end'; runId: string; result?: unknown; isError: boolean; error?: unknown; durationMs: number }
) & {
	runId?: string;
	eventIndex?: number;
	timestamp?: string;
	session?: string;
	parentSession?: string;
	taskId?: string;
	harness?: string;
	operationId?: string;
};

export type FlueEventCallback = (event: FlueEvent) => void | Promise<void>;

// ─── Build ──────────────────────────────────────────────────────────────────

export interface AgentInfo {
	name: string;
	filePath: string;
	triggers: { webhook?: boolean };
}

export interface BuildContext {
	agents: AgentInfo[];
	roles: Record<string, Role>;
	/**
	 * The project root — typically the user's cwd. Source files
	 * (agents/, roles/) live here directly, or under `<root>/.flue/`
	 * if that directory exists (the `.flue/`-as-src layout).
	 */
	root: string;
	/**
	 * Absolute path to the directory the build writes its artifacts into.
	 * Defaults to `<root>/dist`; users can override with `--output`
	 * (CLI) or `output` (programmatic) to redirect the build elsewhere.
	 *
	 * Note that this is the literal output directory — `server.mjs`,
	 * `wrangler.jsonc`, etc. are written directly inside it. The user's
	 * `wrangler.jsonc` and the wrangler deploy-redirect file still anchor
	 * on `root`, regardless of this value.
	 */
	output: string;
	/**
	 * Absolute path to the user's `app.{ts,js,mts,mjs}` entry, if one
	 * exists in the source root. When set, the generated server entry
	 * imports the user's app and dispatches all requests through its
	 * `fetch` method instead of constructing a default Hono app. When
	 * undefined, the generated entry falls back to a default Hono app
	 * with Flue's built-in routes mounted via `flue()`.
	 *
	 * Discovery follows the same extension priority as agents:
	 * `app.ts` > `app.mts` > `app.js` > `app.mjs`.
	 */
	appEntry?: string;
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
	/**
	 * Additional files to write to the output directory (`ctx.output`).
	 * Keys are filenames relative to `output` (e.g. `wrangler.jsonc`,
	 * `Dockerfile`). Values are file contents. May be async.
	 */
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}

export interface BuildOptions {
	/**
	 * The project root — typically the cwd of the `flue` invocation.
	 *
	 * Source files (agents, roles) are discovered from `<root>/.flue/`
	 * if that directory exists, otherwise from `<root>/` directly.
	 * The two layouts never mix — `.flue/` wins unconditionally if present.
	 */
	root: string;
	/**
	 * Where the build artifacts are written. Defaults to `<root>/dist`.
	 * Pass an absolute or root-relative path to redirect the build
	 * somewhere else (e.g. when integrating with another build system that
	 * expects a specific directory). Resolved relative to the cwd at call
	 * time, not `root`.
	 */
	output?: string;
	target?: 'node' | 'cloudflare';
	/** Overrides `target` when provided. */
	plugin?: BuildPlugin;
}
