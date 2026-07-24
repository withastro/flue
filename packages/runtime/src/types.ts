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

import type * as v from 'valibot';
import type { McpConnectionDefinition } from './mcp-types.ts';
import type { ToolDefinition } from './tool-types.ts';

export type {
	ToolContext,
	ToolDefinition,
	ToolInput,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
	ToolStep,
} from './tool-types.ts';

export type { ThinkingLevel };

/**
 * One attachment on a `kind: 'user'` {@link DeliveredMessage}. Mirrors pi-ai's
 * `ImageContent` with an optional uploader-provided `filename` (carried on
 * the wire and the canonical record, but not part of pi-ai's model image
 * shape). Today the only supported attachment is an image.
 */
export type DeliveredAttachment = PromptImage & { filename?: string };

/**
 * A message delivered into an agent's session — the single unified input
 * shape for both `dispatch()` and a direct HTTP prompt (whose wire body is
 * this shape verbatim).
 *
 * `kind: 'user'` is a direct user talking to the assistant: it produces a
 * canonical `user_message` record and projects with `purpose: 'user'` in
 * the conversation (see #404's message classification). Use it for a 1:1
 * chat surface addressing the agent directly, optionally carrying
 * attachments.
 *
 * `kind: 'signal'` models everything beyond that direct exchange and is the
 * right shape for most (if not all) channels: a Slack thread or GitHub issue
 * is a multi-user conversation the agent participates in as one member, and
 * signals model each participant's activity — sender identity and other
 * structured metadata in `attributes`, the message itself in `body` — where
 * a `user` message would conflate other participants with the assistant's
 * own user. It produces a canonical `signal` record. `body` is a plain
 * string today; JSON-stringify structured payloads yourself. (`body`, not
 * `text`/`content`, is named for headroom — a future phase may accept a real
 * JSON value and stringify it internally without a field rename.)
 */
export type DeliveredMessage =
	| { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
	| {
			kind: 'signal';
			/** Caller-defined event/signal type, e.g. `'slack.message'`. */
			type: string;
			body: string;
			attributes?: Record<string, string>;
			tagName?: string;
	  };

/**
 * A message as every `dispatch` surface accepts it: a {@link DeliveredMessage}
 * with its explicit `kind`, or a bare string as shorthand for
 * `{ kind: 'user', body }`.
 */
export type DeliveredMessageInput = string | DeliveredMessage;

/** Input accepted by `dispatch(agent, request)`. */
export interface AgentDispatchRequest {
	/** Target agent instance id. Must be a non-empty string. */
	id: string;
	/** The message delivered to the session. Flue snapshots the value at admission time. */
	message: DeliveredMessageInput;
	/**
	 * Instance-creation data — the seed, consulted only when this send
	 * creates the instance: validated against the agent's `initialData`
	 * schema (when declared) and recorded once, readable forever via
	 * `useInitialData()`. Ignored when the send continues an existing
	 * instance (pair with `uid: null` to error instead).
	 */
	initialData?: unknown;
	/**
	 * Send condition — sends are conditional requests, with the instance uid
	 * playing the ETag:
	 * - omitted: unconditional; continues the instance or creates it.
	 * - a string: continue only the incarnation with this uid; a missing
	 *   instance or mismatched uid rejects at admission (404, nothing
	 *   durable). Cannot be combined with `initialData`.
	 * - `null`: create only when no instance exists; an existing instance
	 *   rejects at admission (409, its uid in the error details).
	 */
	uid?: string | null;
}

/**
 * Internal queue wire shape: an {@link AgentDispatchRequest} resolved against
 * a discovered agent name, its message normalized to the canonical
 * kind-carrying form (the string shorthand expanded). Not part of the public
 * API — `dispatch()` accepts an agent definition and resolves the name itself.
 */
export interface NamedAgentDispatchRequest extends Omit<AgentDispatchRequest, 'message'> {
	/** Discovered agent module name. Must be a non-empty string. */
	agent: string;
	message: DeliveredMessage;
}

/** Receipt returned after a dispatched input is accepted for delivery. */
export interface DispatchReceipt {
	/**
	 * The accepted delivery's submission id — the same identifier settlements
	 * carry, accepted by `read()` to await and read this submission's reply.
	 */
	submissionId: string;
	/** ISO timestamp assigned when dispatch admission begins. */
	acceptedAt: string;
	/**
	 * The contacted instance's uid — minted at birth when this send created
	 * the instance, echoed when it continued one. Pass it back as the `uid`
	 * send condition to guarantee later sends reach this same incarnation.
	 */
	uid: string;
}

/**
 * Inline image content attached to a `prompt()`, `skill()`, or `task()` call.
 * Re-exports pi-ai's `ImageContent` shape: `{ type: 'image', data: base64, mimeType }`.
 * The selected model must support vision input.
 */
export type PromptImage = ImageContent;

// ─── Skill ──────────────────────────────────────────────────────────────────

/** Imported packaged skill reference accepted by `useSkill()` and `session.skill()`. */
export interface SkillReference {
	readonly __flueSkillReference: true;
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

/**
 * An inline skill authored in code — the object accepted by `defineSkill(...)`
 * and `useSkill(...)`. Equivalent to a skill directory: `instructions` is the
 * `SKILL.md` body, and `files` carries supporting resources exactly as a
 * directory import would. The runtime packages a definition lazily the first
 * time the skill is needed; `defineSkill` itself only validates and types.
 */
export interface SkillDefinition {
	readonly name: string;
	/** Catalog line — what the skill does and when to use it. */
	readonly description: string;
	/** The skill's content: the `SKILL.md` body loaded on activation. */
	readonly instructions: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** Space-separated pre-approved tools (experimental in the Agent Skills spec). */
	readonly allowedTools?: string;
	/** Supporting resources, keyed by path relative to the skill root. */
	readonly files?: Readonly<Record<string, string | Uint8Array>>;
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

/**
 * A skill registered with an agent, harness, or profile: a packaged
 * `SKILL.md` import or an inline {@link SkillDefinition}.
 */
export type Skill = SkillReference | SkillDefinition;

/**
 * A skill discovered at runtime from `.agents/skills/` in the session's cwd.
 * Its content stays in the workspace; the runtime reads `SKILL.md` from
 * `skillMdPath` on activation. Never authored directly.
 */
export interface WorkspaceSkill {
	readonly __flueWorkspaceSkill: true;
	readonly name: string;
	readonly description: string;
	readonly directory: string;
	readonly skillMdPath: string;
}

/** Any skill the runtime catalogs: registered by the agent or discovered in the workspace. */
export type RegisteredSkill = Skill | WorkspaceSkill;

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
 * the agent's cwd, which comes from `useSandbox(factory, { cwd })` if set, otherwise from
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
	/** The merged catalog: agent-registered skills plus workspace discovery. */
	skills: Record<string, RegisteredSkill>;
	subagents?: Record<string, SubagentDefinition>;
	/** Agent-wide default model. Per-call values override this. */
	model: Model<any>;
	/** Resolve a model specifier to a Model instance. Throws on invalid specifiers. */
	resolveModel: (model: string) => Model<any> | undefined;
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
	/** Durability settings resolved from the agent definition. */
	durability?: DurabilityConfig;
}

// ─── Agent Runtime Configuration ────────────────────────────────────────────

/**
 * A delegate declared with `useSubagent(...)`. The `agent` function is
 * rendered at delegation time — in its own frame, fresh per task — into the
 * delegate's instructions, tools, skills, and nested subagents. Identity and
 * behavior come only from that render; environment fields (`model`,
 * `thinkingLevel`) inherit from the parent's turn unless overridden here.
 */
export interface SubagentDefinition {
	/** Catalog name the model uses to select this delegate on the `task` tool. */
	name: string;
	/** Catalog line — how the model decides when to delegate to this agent. */
	description: string;
	/** The delegate's agent function — it defines the delegate's whole world. */
	agent: AgentFunction;
	/** Model specifier override. Inherits the parent's model when omitted. */
	model?: string;
	/** Reasoning-effort override. Inherits when omitted. */
	thinkingLevel?: ThinkingLevel;
}

/**
 * A delegate rendered into the self-contained shape the task machinery
 * consumes. Internal: produced at delegation time from a
 * {@link SubagentDefinition}, never authored directly.
 */
export interface ResolvedSubagent {
	name: string;
	description: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	instructions?: string;
	tools?: ToolDefinition[];
	skills?: Skill[];
	subagents?: SubagentDefinition[];
}

/** The internal runtime-config shape one render of an agent composes. */
export interface AgentRuntimeConfig {
	/** Default model specifier. */
	model?: string;
	/** Instructions prepended to discovered workspace context. */
	instructions?: string;
	/** Additional registered skills available to initialized sessions. */
	skills?: Skill[];
	/** Additional custom model-callable tools available to initialized sessions. */
	tools?: ToolDefinition[];
	/** Additional named delegates available for `task` delegation. */
	subagents?: SubagentDefinition[];
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Automatic conversation-compaction configuration. `false` disables
	 * threshold compaction; overflow recovery and explicit `session.compact()`
	 * calls still compact when needed.
	 */
	compaction?: false | CompactionConfig;
	/** Working directory inside the initialized sandbox. */
	cwd?: string;
	/** Sandbox factory used to construct the initialized environment. */
	sandbox?: SandboxFactory;
	/**
	 * MCP servers declared with `useMcpConnection()`, resolved to adapted
	 * tools at submission initialization.
	 */
	mcpConnections?: McpConnectionDefinition[];
}

// ─── Agent functions (Flue Hooks) ────────────────────────────────────────────

/**
 * An agent function: a plain synchronous function that composes an agent's
 * behavior. Flue Hooks in the body attach what it provides (tools,
 * instructions, state); the returned string is its instruction — the prose
 * that teaches the model who it is and how to work. Return nothing for a
 * tools-only body. The author owns the formatting (headings included).
 *
 * An agent is an agent function that declares its model with `useModel()`,
 * and a delegate is an agent function on the `task` catalog —
 * `useSubagent({ name, description, agent: Delegate })`. Shared behavior is
 * composed with custom hooks: plain functions that call `useTool()`,
 * `useInstruction()`, and the other hooks, and may return values to the
 * agent body.
 *
 * ```ts
 * function useRetention(active: () => boolean) {
 *   useTool({
 *     ...offerCredit,
 *     run: (ctx) => (active() ? offerCredit.run(ctx) : 'Refused: no churn risk on record.'),
 *   });
 *   useInstruction(
 *     'Only while the customer is weighing cancellation: you may offer retention incentives.',
 *   );
 * }
 * ```
 *
 * Nearly everything may be declared conditionally: tools, skills, and
 * subagents (the runtime narrates set changes to the model), persisted state
 * (keyed by name in the durable record log regardless of which renders
 * declared it), event hooks (each seam runs whatever the current render
 * declares, at-least-once per delivery), and the sandbox (a presence flip
 * swaps the environment at the next turn boundary). The one invariant:
 * message data (`useDataWriter`) names must be declared identically on every
 * render. Guards like the one above scope when an always-present tool may
 * act. Agent functions must return synchronously — async work lives in tools
 * and resource factories.
 */
export type AgentFunction<TProps = void> = TProps extends void
	? // biome-ignore lint/suspicious/noConfusingVoidType: tools-only agent bodies have no return statement; `void` keeps them assignable.
		() => string | undefined | void
	: // biome-ignore lint/suspicious/noConfusingVoidType: same as above, props form.
		(props: TProps) => string | undefined | void;

/**
 * Props the runtime passes to the top-level agent function — the agent's
 * route data, the way a web framework passes route params to the page
 * component. Only the root agent function receives them; a subagent's agent
 * function gets nothing (a delegate runs in isolation from the parent,
 * intentionally — close over a value explicitly to share it).
 *
 * ```ts
 * // dispatch(support, { id: `order-${orderId}`, message: {...} })
 * export function Assistant({ id }: AgentProps) {
 *   useTool(lookupOrder(id.replace(/^order-/, '')));
 *   return 'Handle support for the one order this instance is bound to.';
 * }
 * ```
 *
 * When the id encodes several structured facts, don't parse them back out of
 * it — pass them as `initialData` and read them with `useInitialData()`.
 *
 * Agents that don't need route data keep the zero-argument form — `() =>`
 * agent functions stay assignable unchanged.
 */
export interface AgentProps {
	/**
	 * This agent instance's id — the `:id` segment of the agent's route
	 * (`/agents/<name>/:id`), or the `--id` passed to `flue run`. Constant
	 * for the instance's whole life.
	 */
	id: string;
}

/**
 * The contract statics an agent function may carry — the parts of the agent
 * the platform reads WITHOUT running the function. All are optional, all
 * are plain properties assigned after the declaration (the `PropTypes`
 * pattern):
 *
 * ```ts
 * export function IssueTriage() {
 *   useModel('anthropic/claude-opus-4-6');
 *   return 'Triage the bound issue.';
 * }
 * IssueTriage.agentName = 'issue-triage';
 * IssueTriage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
 * IssueTriage.durability = { maxAttempts: 5, timeoutMs: 7_200_000 };
 * ```
 */
export interface AgentStatics {
	/**
	 * The agent's durable identity — keys conversation storage everywhere and
	 * the Durable Object class on Cloudflare. Defaults to the function's own
	 * name (`fn.name`, captured at build time in `'use agent'` modules so
	 * minification can't corrupt it). Assign this static to decouple the
	 * durable identity from the source-level function name. Must be a string
	 * literal in `'use agent'` modules: build targets derive durable
	 * identifiers from it before any user code runs.
	 */
	agentName?: string;
	/**
	 * Valibot schema for instance-creation data. Validated once, at the
	 * instance's first contact, synchronously before anything durable is
	 * admitted; a mismatch (including absence, unless the schema accepts
	 * `undefined`) rejects the creating send. The schema-parsed output is what
	 * gets recorded and what `useInitialData()` returns.
	 */
	initialData?: v.GenericSchema;
	/**
	 * Submission retry policy: how long ({@link DurabilityConfig.timeoutMs})
	 * and across how many attempts ({@link DurabilityConfig.maxAttempts}) the
	 * runtime keeps recovering this agent's work before settling it failed.
	 * A static rather than a hook because the platform applies it when the
	 * function is NOT running — including after a crash. Unlike `agentName`,
	 * the value need not be a literal: express environment-dependent policy in
	 * the assigned expression, e.g.
	 * `IssueTriage.durability = process.env.CI ? { timeoutMs: 60_000 } : { timeoutMs: 3_600_000 }`.
	 * Absent, the store defaults apply (1 hour, 10 attempts).
	 */
	durability?: DurabilityConfig;
}

/**
 * An agent: an agent function, addressable anywhere an agent is expected
 * (`init()`, `dispatch()`, `createAgentRouter()`, `start()`). The function IS
 * the agent — behavior comes from its body (hooks + returned instructions),
 * and its contract rides as optional statics ({@link AgentStatics}). In a
 * `'use agent'` module, every exported function with a capitalized name is
 * an agent.
 */
export type Agent = AgentFunction<AgentProps> & AgentStatics;

// ─── Flue Event Context ────────────────────────────────────────────────────

/** Event context for the agent interaction that emitted an event. */
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
	/** Emit observable structured log events into the conversation activity stream. */
	readonly log: FlueLogger;
}

export interface FlueLogger {
	info(message: string, attributes?: Record<string, unknown>): void;
	warn(message: string, attributes?: Record<string, unknown>): void;
	error(message: string, attributes?: Record<string, unknown>): void;
}

// ─── Flue Harness ───────────────────────────────────────────────────────────

/**
 * Initialized agent environment owned by a runtime runner — the surface a
 * `harness: true` tool and the lifecycle-hook contexts receive.
 *
 * `prompt` drives the harness's own scratch conversation: repeated calls
 * continue it, so a later prompt sees what earlier calls established.
 * `sandbox` is the agent's initialized environment itself — the live
 * {@link SessionEnv} the configured {@link SandboxFactory} produced — touched
 * directly, with no conversation record.
 */
export interface FlueHarness {
	readonly name: string;

	/**
	 * Run a model operation with a text instruction in the harness
	 * conversation. Pass `options.result` to require validated structured
	 * data instead of freeform text.
	 */
	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;

	/**
	 * Trigger compaction of the harness conversation immediately. Resolves
	 * (no-op) when there is nothing to compact; rejects when summarization
	 * fails or another operation is in flight.
	 */
	compact(): Promise<void>;

	/**
	 * The environment this agent runs in: the live {@link SessionEnv} resolved
	 * from the agent's declared sandbox (`useSandbox()`). One object carries
	 * the whole surface — `exec`, the file verbs (`readFile`/`writeFile`/
	 * `stat`/`readdir`/`exists`/`mkdir`/`rm`), `cwd`, `resolvePath` — and
	 * operations on it are never recorded in a conversation.
	 *
	 * THROWS when the agent declared no sandbox: there is no default
	 * environment. Tools that may run in sandbox-less agents should not touch
	 * this property.
	 *
	 * Sandboxes are heterogeneous: an adapter may not support every generic
	 * verb (it throws where it cannot) and may enrich the object it returns
	 * with its native surface. Adapter packages ship runtime-checked accessors
	 * that narrow to that surface — call the sandbox the way it actually
	 * works.
	 */
	readonly sandbox: SessionEnv;
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
		skill: Skill | string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(skill: Skill | string, options?: SkillOptions): CallHandle<PromptResponse>;

	/**
	 * Delegate work to a detached child session. Pass `options.agent` to select
	 * a named subagent and `options.result` to require validated data.
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
	/** Named subagent (declared with useSubagent) selected for this delegated task. */
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
	subagents: Record<string, SubagentDefinition>;
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
	 * `id` is the context id (`ctx.id`): the agent instance id. Multiple
	 * harnesses initialized in the same context receive the same `id`, so a
	 * sandbox adapter that keys provider resources on `id` must tolerate repeated
	 * calls with the same value.
	 */
	createSessionEnv(options: { id: string }): Promise<SessionEnv>;
	/**
	 * Replaces the framework default tool list for this sandbox. Omit it for
	 * the standard set over your env. When you do supply one, compose it from
	 * the exported per-tool factories (`createReadTool`, `createWriteTool`,
	 * `createEditTool`, `createBashTool`, `createGrepTool`, `createGlobTool`)
	 * plus your own tools, rather than rebuilding from scratch — e.g. an
	 * exec-less sandbox lists the three file tools and its own executor tool.
	 */
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

/**
 * Classified error details on live observations. In-process only — durable
 * records and settlement rows use their own serializers, which never carry
 * `stack` (stacks expose filesystem paths and deployment layout, so they stay
 * out of anything persisted or replayed).
 */
interface FlueErrorInfo {
	type: string;
	name?: string;
	code?: string;
	message?: string;
	/** Framework-owned structured metadata from a `FlueError` (e.g. validation issues). */
	meta?: Record<string, unknown>;
	/** Throw-site stack, present only when the failure was observed live from a thrown `Error`. */
	stack?: string;
}

interface AgentInvocationInput {
	text: string;
	images?: Array<{ mimeType: string }>;
}

type AgentInvocationOutput =
	{ type: 'text'; text: string; finishReason: string } | { type: 'data'; data: unknown };

export interface FlueObservationDetail {
	agentInput?: AgentInvocationInput;
	agentOutput?: AgentInvocationOutput;
	origin?: ToolOrigin;
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
	/**
	 * The provider's exact finish value before normalization (e.g. Workers AI
	 * `tool_calls` behind `finishReason: 'toolUse'`). Telemetry only — never
	 * part of replay or execution identity; see `provider-diagnostics.ts`.
	 */
	providerFinishReason?: string;
	/**
	 * Response-level gateway log correlation (Cloudflare `cf-aig-log-id`),
	 * read from this response's own headers so concurrent requests cannot
	 * cross-attribute it. Telemetry only.
	 */
	gatewayLogId?: string;
	error?: FlueErrorInfo;
}

type ToolOrigin = 'model' | 'caller' | 'framework' | 'adapter';

type FlueEventVariant =
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
	| {
			/** Streaming fragment of a tool call's JSON-arguments text, for live
			 *  previews of in-flight tool calls. Delivered to in-process `observe()`
			 *  subscribers only — never persisted and never replayed; `tool_start`
			 *  and the canonical tool records remain the source of truth for
			 *  complete arguments. */
			type: 'toolcall_delta';
			toolCallId: string;
			toolName: string;
			argumentTextDelta: string;
	  }
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
	| { type: 'idle' }
	| {
			type: 'submission_settled';
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: {
				name?: string;
				message: string;
				type?: string;
				details?: string;
				dev?: string;
				meta?: Record<string, unknown>;
			};
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
	instanceId?: string;
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
 * Observable runtime activity. Direct and dispatched agent activity carries
 * `instanceId`; submission-scoped activity carries `submissionId`.
 *
 * Every delivered event carries the durable event-format version `v`, a
 * per-context `eventIndex`, and a `timestamp`. Harnesses and sessions add
 * their names where applicable; operations, turns, tasks, and tool calls use
 * generated ids — those correlation fields are optional because they apply
 * only to the activity they describe.
 *
 * Attached-agent streams and `observe()` from `@flue/runtime` deliver live
 * activity; their indexes are per-context ordering, not durable identity.
 *
 * Recognized image content blocks in framework event payloads never carry raw
 * image bytes: their `data` is replaced with the exported
 * `IMAGE_DATA_OMITTED` sentinel. Session history retains real image bytes for
 * model context.
 */
export type FlueEvent = FlueEventInput & {
	/** Durable event-format version. Readers branch on this when the format changes. */
	v: 3;
	eventIndex: number;
	timestamp: string;
};

export type FlueObservation = FlueEvent & FlueObservationDetail;

/**
 * Live activity from a direct attached-agent interaction. Attached-agent
 * events always carry `instanceId`. They are not durable history.
 */
export type AttachedAgentEvent = FlueEvent & {
	instanceId: string;
};

/** Internal pre-decoration event callback (Session → Harness → context emit chain). */
export type FlueEventInputCallback = (
	event: FlueEventInput,
	observation?: FlueObservationDetail,
) => void | Promise<void>;

export type FlueEventCallback = (event: FlueEvent) => void | Promise<void>;
