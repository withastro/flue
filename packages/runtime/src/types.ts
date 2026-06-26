import type { AgentMessage, AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ImageContent, Model } from '@earendil-works/pi-ai';

export interface SignalMessage {
	role: 'signal';
	type: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
	timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
	interface CustomAgentMessages {
		signal: SignalMessage;
	}
}

import type { MiddlewareHandler } from 'hono';
import type * as v from 'valibot';
import type { ActionDefinition } from './action.ts';
import type { EmitData } from './data.ts';
import type { ToolDefinition } from './tool-types.ts';

export type {
	ToolContext,
	ToolDefinition,
	ToolInput,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
} from './tool-types.ts';

export type { ThinkingLevel };

export type AgentRouteHandler = MiddlewareHandler;
export type WorkflowRouteHandler = MiddlewareHandler;
export type WorkflowRunsHandler = MiddlewareHandler;

/** Input accepted by the agent-definition overload of `dispatch(...)`. */
export interface AgentDispatchRequest {
	/** Target agent instance id. Must be a non-empty string. */
	id: string;
	/**
	 * JSON-like input delivered to the session. Required; use `null` for an
	 * intentional empty payload. Flue snapshots the value at admission time.
	 */
	input: unknown;
}

/** Input accepted by the named-agent overload of `dispatch(...)`. */
export interface NamedAgentDispatchRequest extends AgentDispatchRequest {
	/** Discovered agent module name. Must be a non-empty string. */
	agent: string;
}

/** Receipt returned after a dispatched input is accepted for delivery. */
export interface DispatchReceipt {
	/** Generated delivery identifier. This is not a workflow `runId`. */
	dispatchId: string;
	/** ISO timestamp assigned when dispatch admission begins. */
	acceptedAt: string;
}

export interface DirectAgentPayload {
	message: string;
	images?: PromptImage[];
}

/** Context passed to a {@link defineAgent} initializer. */
export interface AgentInitializerContext<TEnv = Record<string, any>> {
	/** Agent instance id or workflow run id. */
	readonly id: string;
	/** Platform environment bindings supplied by the runtime. */
	readonly env: TEnv;
}

/**
 * Inline image content attached to a `prompt()`, `skill()`, or `task()` call.
 * Re-exports pi-ai's `ImageContent` shape: `{ type: 'image', data: base64, mimeType }`.
 * The selected model must support vision input.
 */
export type PromptImage = ImageContent;

// ─── Skill ──────────────────────────────────────────────────────────────────

/** Imported packaged skill reference accepted by `session.skill()`. */
export interface SkillReference {
	readonly __flueSkillReference: true;
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface PackagedSkillFile {
	readonly encoding: 'base64';
	readonly kind: 'text' | 'binary';
	readonly content: string;
}

export interface PackagedSkillDirectory {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly files: Record<string, PackagedSkillFile>;
}

/** Skill metadata registered with an agent, harness, or profile. */
export type Skill =
	| SkillReference
	| {
			name: string;
			description: string;
	  };

// ─── File Stat ──────────────────────────────────────────────────────────────

/**
 * File metadata returned by {@link FlueFs.stat}.
 *
 * `isSymbolicLink`, `size`, and `mtime` are omitted when the sandbox
 * sandbox adapter's provider does not expose them — sandbox adapters must never
 * fabricate placeholder values.
 */
export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink?: boolean;
	size?: number;
	mtime?: Date;
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
			 * Wall-clock deadline hint in milliseconds. Forwarded to the
			 * underlying sandbox adapter's native timeout option (E2B
			 * `timeoutMs`, Daytona `timeout`, etc.) so signal-blind providers
			 * still observe the deadline with full fidelity. Sandbox adapters whose
			 * provider only supports a coarser granularity may round the value
			 * up, never down.
			 *
			 * Independent of `signal`. Callers that have a deadline AND want
			 * mid-flight cancellation should pass both: `timeoutMs` for
			 * provider-native enforcement, `signal` for ad-hoc abort. The
			 * bash tool does this when the model emits a `timeout` parameter.
			 */
			timeoutMs?: number;
			/**
			 * Cancel the in-flight command. Aborting rejects with an
			 * `AbortError`. Sandbox adapters that wrap a signal-aware SDK observe
			 * this mid-flight; others see it only before/after the remote
			 * call returns. Use `timeoutMs` for guaranteed deadline
			 * enforcement on signal-blind sandbox adapters.
			 */
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;

	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	/** Creates missing parent directories (the `FlueFs.writeFile` guarantee). */
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
 * sandbox adapter points at (a remote container, microVM, in-process FS, etc.).
 *
 * Operations are out-of-band — they don't appear in the conversation
 * transcript. The model has its own `read`/`write`/`edit` tools for
 * filesystem work it should reason about. Use `fs` for plumbing (staging
 * files, capturing artifacts, managing scratch space) the model shouldn't
 * see. If a write should feed into the model's next turn, prompt the model
 * to read the file itself.
 *
 * Paths can be absolute or relative. Relative paths are resolved against
 * the agent's cwd, which comes from `defineAgent(() => ({ cwd }))` if set, otherwise from
 * the sandbox adapter's default (varies by provider). Use absolute paths
 * for portability across sandbox adapters.
 */
export interface FlueFs {
	/** Read a UTF-8 file. Throws if the path doesn't exist or isn't a file. */
	readFile(path: string): Promise<string>;

	/** Read a file as raw bytes. Use this for binary content. */
	readFileBuffer(path: string): Promise<Uint8Array>;

	/**
	 * Write content to a file. Creates the file if it doesn't exist; replaces
	 * it if it does. Accepts both UTF-8 strings and raw bytes.
	 *
	 * Missing parent directories are created automatically, in every sandbox
	 * mode — `fs.writeFile('out/nested/report.md', ...)` never requires a
	 * prior `mkdir`. The runtime implements this guarantee itself, so sandbox
	 * sandbox adapters don't need to create parents in their `writeFile`.
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
	/**
	 * Token headroom to reserve in the context window. Compaction triggers
	 * when used tokens exceed `contextWindow - reserveTokens`.
	 *
	 * Defaults to a model-aware value capped at 20000 tokens, shrunk for models
	 * with smaller output limits and adjusted when the reserve would consume
	 * half or more of a small context window.
	 */
	reserveTokens?: number;
	/**
	 * Recent tokens to preserve unsummarized after compaction. Older messages
	 * are folded into a summary; this many tokens of recent history remain
	 * verbatim so the model keeps immediate context (file paths, tool
	 * results, current focus). Defaults to 8000.
	 *
	 * Lower values compact more aggressively at the cost of recent-context
	 * fidelity. Setting above ~10% of the contextWindow is rarely useful.
	 */
	keepRecentTokens?: number;
	/**
	 * Override the model used for summarization. Defaults to the session's
	 * model. Useful for cost optimization (cheap summarizer on an expensive
	 * session model) or quality routing (long-context summarizer on a
	 * short-context session). Format: `'provider-id/model-id'`.
	 */
	model?: string;
}

// ─── Durability ─────────────────────────────────────────────────────────────

export interface DurabilityConfig {
	/**
	 * Maximum total attempts before the submission is terminalized as
	 * failed. The initial run counts as the first attempt; each DO reset or
	 * deploy that interrupts a running submission consumes another.
	 * Defaults to 10.
	 */
	maxAttempts?: number;
	/**
	 * Maximum wall-clock milliseconds for a single submission. Submissions
	 * that exceed this limit are aborted and settled as failed. Defaults to
	 * 3,600,000 (one hour). Set higher for long-running agents (e.g.
	 * 21,600,000 for a 6-hour agent).
	 */
	timeoutMs?: number;
}

// ─── Agent Config (internal, passed to the harness at runtime) ──────────────

export interface AgentConfig {
	/** Discovered at runtime from AGENTS.md + .agents/skills/ in the session's cwd. */
	systemPrompt: string;
	/** Agent instructions prepended ahead of discovered workspace context. */
	instructions?: string;
	/** Agent-definition skills merged into each discovered skill catalog. */
	definitionSkills?: Skill[];
	/** Discovered at runtime from .agents/skills/ in the session's cwd. */
	skills: Record<string, Skill>;
	subagents?: Record<string, AgentProfile>;
	actions?: ActionDefinition[];
	/**
	 * Agent-wide default model. Undefined when the user explicitly passes
	 * `defineAgent(() => ({ model: false }))`, so each model-using call must provide a
	 * call-site override.
	 */
	model: Model<any> | undefined;
	/** Resolve model config to a Model instance. Throws on invalid model specifiers. */
	resolveModel: (model: ModelConfig | undefined) => Model<any> | undefined;
	/**
	 * Agent-wide default reasoning effort. Per-call values override this. The
	 * harness substitutes `"medium"` when unset; see `AgentRuntimeConfig.thinkingLevel`.
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Compaction tuning. `false` disables threshold compaction (overflow
	 * recovery and explicit `session.compact()` still run). An object
	 * overrides individual fields against model-aware defaults. Undefined
	 * uses defaults.
	 */
	compaction?: false | CompactionConfig;
	/** Durability settings resolved from the agent profile. */
	durability?: DurabilityConfig;
}

/** Model specifier, or `false` to require call-level model selection. */
export type ModelConfig = string | false;

// ─── Agent Profile and Runtime Creation ─────────────────────────────────────

/** Reusable agent behavior accepted by {@link defineAgentProfile}. */
export interface AgentProfile {
	/** Profile name. Required when selecting this profile with `session.task()`. */
	name?: string;
	description?: string;
	/** Default model specifier. Set to `false` to require call-level model selection. */
	model?: ModelConfig;
	/** Instructions prepended to discovered workspace context. */
	instructions?: string;
	/** Registered skills available to sessions initialized from this profile. */
	skills?: Skill[];
	/** Custom model-callable tools available to sessions initialized from this profile. */
	tools?: ToolDefinition[];
	actions?: ActionDefinition[];
	/** Named profiles available for delegated `session.task()` operations. */
	subagents?: AgentProfile[];
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Automatic conversation-compaction configuration. `false` disables
	 * threshold compaction; overflow recovery and explicit `session.compact()`
	 * calls still compact when needed.
	 */
	compaction?: false | CompactionConfig;
	/**
	 * Durability configuration for durable agent submissions. Controls
	 * recovery attempt limits and submission timeouts. Rejected on subagent
	 * profiles — delegated task sessions run inside the parent operation.
	 */
	durability?: DurabilityConfig;
}

/** Configuration returned by a {@link defineAgent} initializer. */
export interface AgentRuntimeConfig {
	/** Reusable baseline profile. Agent definition fields replace or extend profile values. */
	profile?: AgentProfile;
	/** Optional human-facing description of what this agent does. */
	description?: string;
	/** Default model specifier. Set to `false` to require call-level model selection. */
	model?: ModelConfig;
	/** Instructions prepended to discovered workspace context. */
	instructions?: string;
	/** Additional registered skills available to initialized sessions. */
	skills?: Skill[];
	/** Additional custom model-callable tools available to initialized sessions. */
	tools?: ToolDefinition[];
	actions?: ActionDefinition[];
	/** Additional named profiles available for delegated `session.task()` operations. */
	subagents?: AgentProfile[];
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Automatic conversation-compaction configuration. `false` disables
	 * threshold compaction; overflow recovery and explicit `session.compact()`
	 * calls still compact when needed.
	 */
	compaction?: false | CompactionConfig;
	/**
	 * Durability configuration for durable agent submissions. Controls
	 * recovery attempt limits and submission timeouts.
	 */
	durability?: DurabilityConfig;
	/** Working directory inside the initialized sandbox. */
	cwd?: string;
	/** Sandbox factory used to construct the initialized environment. */
	sandbox?: SandboxFactory;
}

/** Opaque agent initializer created by {@link defineAgent}. */
export interface AgentDefinition<TEnv = Record<string, any>> {
	readonly __flueAgentDefinition: true;
	initialize(context: AgentInitializerContext<TEnv>): AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
}

// ─── Flue Event Context ────────────────────────────────────────────────────

/** Event context for the agent interaction or workflow run that emitted an event. */
export interface FlueEventContext<TEnv = Record<string, any>> {
	/** Workflow run/instance id, or stable agent instance id during agent processing. */
	readonly id: string;
	readonly agentName: string | undefined;
	/** Platform env bindings (process.env on Node, Cloudflare bindings on Workers). */
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
	 * Undefined when the agent is invoked outside an HTTP context. Durable or
	 * recovered processing may receive a synthetic internal request instead of
	 * the original caller request. Authenticate and capture required transport
	 * metadata before durable admission; do not assume later processing retains
	 * original headers, cookies, query parameters, URL, or body.
	 *
	 * For client IP, parse the platform header yourself, e.g.
	 * `req.headers.get('cf-connecting-ip')` on Cloudflare, or
	 * `req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` behind a
	 * trusted proxy on Node. Don't trust headers you don't control.
	 */
	readonly req: Request | undefined;
	/** Emit observable structured log events, persisted in a run stream only during a workflow run. */
	readonly log: FlueLogger;
	/** Emit trusted structured UI state that is persisted verbatim for authorized stream readers. */
	readonly emitData: EmitData;
}

export interface FlueLogger {
	info(message: string, attributes?: Record<string, unknown>): void;
	warn(message: string, attributes?: Record<string, unknown>): void;
	error(message: string, attributes?: Record<string, unknown>): void;
}

// ─── Flue Harness ───────────────────────────────────────────────────────────

/** Initialized agent environment owned by a runtime runner. */
export interface FlueHarness {
	readonly name: string;

	/**
	 * Get or create a session in this harness. Defaults to the `'default'`
	 * session. Names beginning with `'task:'` are reserved for delegated tasks.
	 */
	session(name?: string): Promise<FlueSession>;

	/** Explicit session management helpers. */
	readonly sessions: FlueSessions;

	/** Run a shell command in the harness sandbox without recording it in a conversation. */
	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;

	/**
	 * Read and write files in the harness sandbox without recording them in a
	 * conversation. See {@link FlueFs}.
	 */
	readonly fs: FlueFs;
}

/**
 * Explicit session management helpers exposed by {@link FlueHarness.sessions}.
 * Names beginning with `'task:'` are reserved for delegated tasks.
 */
export interface FlueSessions {
	/** Load an existing session. Defaults to `'default'`. Throws if it does not exist. */
	get(name?: string): Promise<FlueSession>;
	/** Create a new session. Defaults to `'default'`. Throws if it already exists. */
	create(name?: string): Promise<FlueSession>;
}

// ─── Flue Session ───────────────────────────────────────────────────────────

/**
 * Awaitable handle returned by `prompt()`, `skill()`, `task()`, and `shell()`.
 * Aborting rejects the awaited value with an `AbortError` (a `DOMException`).
 * Pass `options.signal` to merge an external `AbortSignal` (e.g.
 * `AbortSignal.timeout(ms)`) with the handle's.
 */
export interface CallHandle<T> extends Promise<T> {
	/** Fires when the call is aborted, whether via `abort()` or `options.signal`. */
	readonly signal: AbortSignal;
	/** Cancel the in-flight call. */
	abort(reason?: unknown): void;
}

/** Named conversation state inside a {@link FlueHarness}. */
export interface FlueSession {
	/** Session name. */
	readonly name: string;
	/** Persisted opaque identity for this conversation. */
	readonly conversationId: string;

	/**
	 * Run a model operation with a text instruction. Pass `options.result` to
	 * require validated structured data instead of freeform text.
	 */
	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;

	/** Run a shell command and record its command exchange in conversation state. */
	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;

	/**
	 * Read and write files in the session's sandbox. See {@link FlueFs}.
	 * Unlike {@link FlueSession.shell}, fs operations are not recorded in
	 * the conversation transcript.
	 */
	readonly fs: FlueFs;

	/**
	 * Run a registered skill. Pass `options.result` to require validated
	 * structured data instead of freeform text.
	 */
	skill<S extends v.GenericSchema>(
		skill: SkillReference | string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;

	/**
	 * Delegate work to a detached child session. Pass `options.agent` to select
	 * a named subagent profile and `options.result` to require validated data.
	 * Persisted child history remains part of the parent-owned conversation topology.
	 */
	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;

	/**
	 * Trigger compaction immediately. Equivalent to what automatic
	 * compaction would run when crossing the configured threshold, but
	 * on-demand — useful for surfacing a `/compact`-style action in agent
	 * UIs without waiting for the window to fill.
	 *
	 * Resolves successfully (no-op) when there is nothing to compact.
	 * Rejects when summarization fails or is aborted. Throws if another
	 * operation (`prompt` / `skill` / `task` / `shell`) is in flight on
	 * this session — start a separate session for parallel branches.
	 *
	 * Emits a {@link FlueEvent} `compaction_start` (with `reason: "manual"`)
	 * followed by `compaction`. The summarization LLM cost is recorded the
	 * same as automatic compaction.
	 */
	compact(): Promise<void>;
}

/**
 * Token + cost usage aggregated across every LLM call dispatched by a
 * single prompt(), skill(), or task() invocation, including:
 *   - every assistant turn produced by the call,
 *   - any result-extraction retry triggered by `result:` callers,
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
 * call > agent precedence). When more than one model runs during the
 * call (rare; e.g. cross-model flows), this reflects the model in effect for
 * the call's primary turn.
 */
export interface PromptModel {
	provider: string;
	id: string;
}

/** Freeform text response returned by `session.prompt()`, `session.skill()`, and `session.task()`. */
export interface PromptResponse {
	/** Assistant text returned by the operation. */
	text: string;
	/** Aggregated token and cost usage for model work performed by the operation. */
	usage: PromptUsage;
	/** Model selected for the operation's primary turn. */
	model: PromptModel;
}

/** Validated structured response returned when an operation receives `options.result`. */
export interface PromptResultResponse<T> {
	/** Validated structured data inferred from the supplied schema. */
	data: T;
	usage: PromptUsage;
	model: PromptModel;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** Option fields shared by `session.prompt()`, `session.skill()`, and `session.task()`. */
interface OperationOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Require validated structured data and resolve with `response.data`. */
	result?: S;
	/** Additional custom model-callable tools for this operation. */
	tools?: ToolDefinition[];
	/** Model specifier override for this operation. */
	model?: string;
	/** Override reasoning effort for this call. See `AgentRuntimeConfig.thinkingLevel`. */
	thinkingLevel?: ThinkingLevel;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
	/** Images attached to the operation's user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.prompt()` call. */
export interface PromptOptions<
	S extends v.GenericSchema | undefined = undefined,
> extends OperationOptions<S> {
	/** Images attached to this user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.skill()` call. */
export interface SkillOptions<
	S extends v.GenericSchema | undefined = undefined,
> extends OperationOptions<S> {
	/** Arguments included with the skill instruction. */
	args?: Record<string, unknown>;
	/** Images attached to the skill's user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.task()` call. */
export interface TaskOptions<
	S extends v.GenericSchema | undefined = undefined,
> extends OperationOptions<S> {
	/** Named subagent profile selected for this delegated task. */
	agent?: string;
	/** Working directory for the detached task session. Defaults to the parent session cwd. */
	cwd?: string;
	/** Images attached to the task's initial user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

/** Options for `harness.shell()` and `session.shell()`. */
export interface ShellOptions {
	/** Environment variables supplied to the command. */
	env?: Record<string, string>;
	/** Working directory supplied to the command. */
	cwd?: string;
	/**
	 * Wall-clock deadline in milliseconds, forwarded to the sandbox
	 * sandbox adapter. See `SessionEnv.exec`.
	 */
	timeoutMs?: number;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
}

/** Result returned by `harness.shell()` and `session.shell()`. */
export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

export interface SessionToolFactoryOptions {
	subagents: Record<string, AgentProfile>;
}

/** Sandbox adapter-supplied model-facing tools. Flue appends `task` separately. */
export type SessionToolFactory = (
	env: SessionEnv,
	options: SessionToolFactoryOptions,
) => AgentTool<any>[];

/** Wraps external sandboxes (Daytona, CF Containers, etc.) into Flue's SessionEnv. */
export interface SandboxFactory {
	/**
	 * Called once per initialized harness — one call per `init()` — and every
	 * session and task session of that harness shares the returned env.
	 *
	 * `id` is the context id (`ctx.id`): the agent instance id for direct
	 * agent requests, or the workflow run id inside a workflow. Multiple
	 * harnesses initialized in the same context receive the same `id`, so a
	 * sandbox adapter that keys provider resources on `id` must tolerate repeated
	 * calls with the same value.
	 */
	createSessionEnv(options: { id: string }): Promise<SessionEnv>;
	/** Replaces the framework default tool list for this sandbox. */
	tools?: SessionToolFactory;
}

/**
 * Structural type for the just-bash `Bash` runtime a {@link BashFactory} returns.
 * Purely structural — no just-bash import, so the runtime stays platform-agnostic.
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

/**
 * Factory that constructs the agent's Bash-like runtime. Called once at init.
 * Pass to `bash()` to obtain the {@link SandboxFactory} that `sandbox` accepts.
 */
export type BashFactory = () => BashLike | Promise<BashLike>;

export type LlmTextContent = {
	type: 'text';
	text: string;
	textSignature?: string;
};

export type LlmThinkingContent = {
	type: 'thinking';
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};

export type LlmImageContent = {
	type: 'image';
	data: string;
	mimeType: string;
};

export type LlmToolCall = {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

export type LlmUserMessage = {
	role: 'user';
	content: string | (LlmTextContent | LlmImageContent)[];
};

export type LlmAssistantMessage = {
	role: 'assistant';
	content: (LlmTextContent | LlmThinkingContent | LlmToolCall)[];
};

export type LlmToolResultMessage = {
	role: 'toolResult';
	toolCallId: string;
	toolName: string;
	content: (LlmTextContent | LlmImageContent)[];
	isError: boolean;
};

export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

export type LlmTool = {
	name: string;
	description: string;
	parameters: unknown;
};

export type LlmTurnPurpose = 'agent' | 'compaction' | 'compaction_prefix';

interface FlueErrorInfo {
	type: string;
	name?: string;
	code?: string;
	message?: string;
}

interface AgentInvocationInput {
	text: string;
	images?: Array<{ mimeType: string }>;
}

type AgentInvocationOutput =
	| { type: 'text'; text: string; finishReason: string }
	| { type: 'data'; data: unknown };

export interface FlueObservationDetail {
	agentInput?: AgentInvocationInput;
	agentOutput?: AgentInvocationOutput;
	origin?: ToolOrigin;
	toolType?: ToolSemanticType;
	description?: string;
	args?: unknown;
	effectiveResult?: unknown;
	toolCallId?: string;
	errorInfo?: FlueErrorInfo;
}

export interface ModelRequestInput {
	systemPrompt?: string;
	messages: LlmMessage[];
	tools?: LlmTool[];
}

export interface ModelRequestInfo {
	providerId: string;
	providerName: string;
	requestedModel: string;
	api: string;
	serverAddress?: string;
	serverPort?: number;
	reasoningLevel?: string;
	maxTokens?: number;
	temperature?: number;
	contextCompacted?: true;
}

export interface ModelRequest extends ModelRequestInfo {
	input: ModelRequestInput;
}

export interface ModelResponse {
	responseId?: string;
	responseModel?: string;
	output?: LlmAssistantMessage;
	usage?: PromptUsage;
	finishReason?: string;
	error?: FlueErrorInfo;
}

type ToolOrigin = 'model' | 'caller' | 'framework' | 'adapter';
type ToolSemanticType = 'function' | 'extension' | 'datastore';

type FlueEventVariant =
	| {
			type: 'run_start';
			runId: string;
			workflowName: string;
			startedAt: string;
			input: unknown;
	  }
	| {
			type: 'run_resume';
			runId: string;
			workflowName: string;
			startedAt: string;
	  }
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages: AgentMessage[] }
	| { type: 'turn_start'; turnId: string; purpose: LlmTurnPurpose }
	| {
			type: 'turn_request';
			turnId: string;
			purpose: LlmTurnPurpose;
			request: ModelRequest;
	  }
	| {
			type: 'turn_messages';
			turnId: string;
			purpose: LlmTurnPurpose;
			message: AgentMessage;
			toolResults: AgentMessage[];
	  }
	| { type: 'message_start'; message: AgentMessage; turnId: string }
	| { type: 'message_end'; message: AgentMessage; turnId: string }
	| { type: 'text_delta'; text: string }
	| { type: 'thinking_start'; contentIndex?: number }
	| { type: 'thinking_delta'; contentIndex?: number; delta: string }
	| { type: 'thinking_end'; contentIndex?: number; content: string }
	| { type: 'tool_start'; toolName: string; toolCallId: string; args?: any }
	| {
			type: 'tool';
			toolName: string;
			toolCallId: string;
			isError: boolean;
			result?: unknown;
			durationMs: number;
	  }
	| {
			type: 'turn';
			turnId: string;
			purpose: LlmTurnPurpose;
			durationMs: number;
			request: ModelRequestInfo;
			response: ModelResponse;
			isError: boolean;
	  }
	| { type: 'task_start'; taskId: string; prompt: string; agent?: string; cwd?: string }
	| {
			type: 'task';
			taskId: string;
			agent?: string;
			isError: boolean;
			result?: any;
			durationMs: number;
	  }
	| {
			type: 'compaction_start';
			reason: 'threshold' | 'overflow' | 'manual';
			estimatedTokens: number;
	  }
	| {
			type: 'compaction';
			messagesBefore: number;
			messagesAfter: number;
			durationMs: number;
			isError: boolean;
			error?: unknown;
			usage?: PromptUsage;
	  }
	| {
			type: 'operation_start';
			operationId: string;
			operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
	  }
	| {
			type: 'operation';
			operationId: string;
			operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
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
	| {
			type: 'data';
			name: string;
			id?: string;
			/** Persisted verbatim. Do not include raw image bytes, secrets, or unsanitized PII. */
			data: unknown;
	  }
	| { type: 'idle' }
	| {
			type: 'submission_settled';
			submissionId: string;
			outcome: 'completed' | 'failed';
			result?: unknown;
			error?: {
				name?: string;
				message: string;
				type?: string;
				details?: string;
				dev?: string;
				meta?: Record<string, unknown>;
			};
	  }
	| {
			type: 'run_end';
			runId: string;
			result?: unknown;
			isError: boolean;
			error?: unknown;
			durationMs: number;
	  };

/**
 * Event payload as constructed at an emission site, before runtime decoration.
 *
 * Internal construction shape: harnesses and sessions add their names where
 * applicable, and the per-context emit path stamps the delivered envelope
 * fields (`v`, `eventIndex`, `timestamp`) before any subscriber, stream, or
 * store sees the event. Consumers always receive the decorated
 * {@link FlueEvent}.
 */
export type FlueEventInput = FlueEventVariant & {
	runId?: string;
	instanceId?: string;
	dispatchId?: string;
	submissionId?: string;
	agentName?: string;
	conversationId?: string;
	session?: string;
	parentSession?: string;
	taskId?: string;
	harness?: string;
	operationId?: string;
	turnId?: string;
};

/**
 * Observable runtime activity. Workflow events carry `runId`; direct and
 * dispatched agent activity carries `instanceId` without becoming a workflow
 * run. Dispatched activity may also carry `dispatchId`.
 *
 * Every delivered event carries the durable event-format version `v`, a
 * per-context `eventIndex`, and a `timestamp`. Harnesses and sessions add
 * their names where applicable; operations, turns, tasks, and tool calls use
 * generated ids — those correlation fields are optional because they apply
 * only to the activity they describe.
 *
 * Persisted workflow events always carry `runId` and `eventIndex`; together they
 * form the immutable persisted identity for one workflow event. Attached-agent
 * streams and `observe()` from `@flue/runtime` deliver live activity; their
 * indexes are per-context ordering, not durable identity.
 *
 * Recognized image content blocks in framework event payloads never carry raw
 * image bytes: their `data` is replaced with the exported
 * `IMAGE_DATA_OMITTED` sentinel. Application-authored `data` event payloads
 * are persisted verbatim and must not include raw image bytes, secrets, or
 * unsanitized PII. Session history retains real image bytes for model context.
 */
export type FlueEvent = FlueEventInput & {
	/** Durable event-format version. Readers branch on this when the format changes. */
	v: 3;
	eventIndex: number;
	timestamp: string;
};

export const FLUE_EVENT_SCHEMA_REVISION = 3;

export type FlueObservation = FlueEvent & FlueObservationDetail;

/**
 * Live activity from a direct attached-agent interaction. Attached-agent events
 * require `instanceId`, omit workflow lifecycle events, and never carry
 * `runId`. They are not durable workflow history.
 */
export type AttachedAgentEvent = Exclude<
	FlueEvent,
	{ type: 'run_start' } | { type: 'run_resume' } | { type: 'run_end' }
> & {
	runId?: never;
	instanceId: string;
};

/** Internal pre-decoration event callback (Session → Harness → context emit chain). */
export type FlueEventInputCallback = (
	event: FlueEventInput,
	observation?: FlueObservationDetail,
) => void | Promise<void>;

export type FlueEventCallback = (event: FlueEvent) => void | Promise<void>;
export type AttachedAgentEventCallback = (event: AttachedAgentEvent) => void | Promise<void>;
