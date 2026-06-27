/**
 * Complete error framework for Flue.
 *
 * This file contains both the error vocabulary (concrete error classes) and
 * the framework utilities (renderers, type guards, request parsing helpers).
 * Previously split across `errors.ts` and `error-utils.ts`, but consolidated
 * for better LLM comprehension.
 *
 * ──── Why this file exists ────────────────────────────────────────────────
 *
 * Concentrating every error in one file is deliberate. When all errors are
 * visible together, it's easy to:
 *
 *   - Keep message tone and detail level consistent across the codebase.
 *   - Notice duplicates ("oh, we already have an error for this case").
 *   - Establish norms by example — when adding a new error, look at the
 *     neighbors above and copy the pattern.
 *
 * Application code throughout the codebase should reach for one of these
 * classes rather than constructing a `FlueError` ad hoc. If no existing class
 * fits, add one here. That's the entire convention.
 *
 * ──── Two audiences: caller vs. developer ─────────────────────────────────
 *
 * The reader of an error message is one of two distinct audiences:
 *
 *   - The *caller*: an HTTP client. Possibly third-party, possibly hostile,
 *     possibly an end user who shouldn't even know we're built on Flue.
 *     Sees `message` and `details` always.
 *
 *   - The *developer*: the human running the service (`flue dev`, `flue run`,
 *     local debugging). Sees `dev` in addition, but only when the generated
 *     runtime is configured for local development.
 *
 * Every error class must classify its prose by audience. The required-but-
 * possibly-empty shape of both `details` and `dev` is the discipline:
 * forgetting either field is a TypeScript error, and writing `''` is a
 * deliberate "I have nothing for that audience" decision.
 *
 * Concretely:
 *
 *   - `message`     One sentence. Caller-safe. Always rendered.
 *   - `details`     Longer caller-safe prose. About the request itself, the
 *                   contract, what the caller can do to fix it. Always
 *                   rendered. NEVER includes:
 *                     - sibling/neighbor enumeration (leaks namespace)
 *                     - filesystem paths or "agents/" / "skills/" / etc.
 *                       (leaks framework internals)
 *                     - source-code-level fix instructions ("add ... to your
 *                       agent definition") (caller can't act on these)
 *                     - build-time or runtime mechanics
 *   - `dev`         Longer dev-audience prose. Available alternatives,
 *                   filesystem layout, framework guidance, source-code-level
 *                   fix instructions. Rendered ONLY in local development.
 *
 * When in doubt, put information in `dev`. The default is conservative.
 *
 * ──── Conventions for new error classes ───────────────────────────────────
 *
 *   - Class name: PascalCase, suffixed with `Error`. E.g. `AgentNotFoundError`.
 *   - The class owns its `type` constant (snake_case). Set once in the
 *     subclass constructor, never passed by callers. Renaming the wire type
 *     is then a one-line change.
 *   - Constructor takes ONLY structured input data (the values used to build
 *     the message). The constructor assembles `message`, `details`, and
 *     `dev` from that data, so call sites never reinvent phrasing.
 *   - `details` and `dev` are both required strings. Pass `''` only when
 *     there's genuinely nothing more to say for that audience.
 *   - For HTTP errors, the class sets its own `status` (and `headers` where
 *     relevant). Callers do not pick HTTP status codes ad-hoc.
 *
 * Worked example (matches `AgentNotFoundError` below):
 *
 *     new AgentNotFoundError({ name, available });
 *     // builds:
 *     //   message: `Agent "foo" is not registered.`
 *     //   details: `Verify the agent name is correct.`
 *     //   dev:     `Available agents: "echo", "greeter". Agents are
 *     //            loaded from the project root's "agents/" directory at
 *     //            build time. ...`
 *
 * The wire response in production omits `dev`; in `flue dev` / `flue run`
 * it includes `dev`. That separation is what lets the dev field be richly
 * helpful without leaking namespace state to public callers.
 *
 * Counter-example to avoid:
 *
 *     class AgentNotFoundError extends FlueHttpError {
 *       constructor(message: string) {                       // ✗ free-form
 *         super({                                            // ✗ wrong type
 *           type: 'agent_error',
 *           message,
 *           details: 'Available: "x", "y", "z"',             // ✗ leaks names
 *           dev: '',                                         // ✗ wasted field
 *           status: 500,                                     // ✗ wrong status
 *         });
 *       }
 *     }
 *
 * The structured-constructor pattern below is what prevents that drift.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format a list of items for inclusion in error details. Empty lists render
 * as the supplied fallback (default `(none)`), so messages read naturally
 * regardless of whether anything is registered.
 *
 * Module-private: only used by the concrete error subclasses below. Promote
 * to `export` if/when a real cross-file caller appears.
 */
function formatList<T>(items: readonly T[], fallback = '(none)'): string {
	if (items.length === 0) return fallback;
	return items.map((item) => `"${String(item)}"`).join(', ');
}

// ─── Base classes ───────────────────────────────────────────────────────────

interface FlueErrorOptions {
	/**
	 * Stable, machine-readable identifier (snake_case). Set once per subclass.
	 * Callers don't pass this — the subclass constructor does.
	 */
	type: string;
	/**
	 * One-sentence summary of what went wrong. Caller-safe — always rendered
	 * on the wire.
	 */
	message: string;
	/**
	 * Caller-audience longer-form explanation. Always rendered on the wire.
	 *
	 * Must be safe to expose to any HTTP client, including third-party or
	 * hostile callers. Do NOT include sibling enumeration, filesystem paths,
	 * framework-internal mechanics, or source-code fix instructions — those
	 * belong in `dev`.
	 *
	 * Required: pass `''` only when there's genuinely nothing more to say to
	 * the caller. The required-but-possibly-empty shape is intentional — it
	 * forces a deliberate decision rather than a thoughtless omission.
	 */
	details: string;
	/**
	 * Developer-audience longer-form explanation. Rendered on the wire ONLY
	 * when the generated runtime is configured for local development.
	 *
	 * Use this for everything that helps the developer running the service
	 * but shouldn't reach a public caller: available alternatives, filesystem
	 * paths, framework guidance, source-code fix instructions, configuration
	 * hints.
	 *
	 * Required: pass `''` only when there's genuinely nothing dev-specific
	 * to add (e.g. a malformed-JSON error has nothing to say to the dev that
	 * isn't already in `details`).
	 */
	dev: string;
	/**
	 * Optional structured machine-readable data. Use only when downstream
	 * tooling genuinely benefits — most errors should leave this unset.
	 */
	meta?: Record<string, unknown>;
	/**
	 * The underlying error, when wrapping. Logged server-side; never sent
	 * over the wire.
	 */
	cause?: unknown;
}

/**
 * Base class for every error Flue throws. Do not instantiate directly in
 * application code — extend it via a subclass below. If a use case isn't
 * covered, add a new subclass here rather than throwing a raw `FlueError`.
 *
 * Exported (and re-exported from the package root) as the catchable base:
 * application code distinguishes Flue failures from arbitrary errors with
 * `err instanceof FlueError`, then narrows via the concrete subclasses or
 * the stable `type` field. Message strings are not API.
 */
export class FlueError extends Error {
	readonly type: string;
	readonly details: string;
	readonly dev: string;
	readonly meta: Record<string, unknown> | undefined;
	override readonly cause: unknown;

	constructor(options: FlueErrorOptions) {
		super(options.message);
		this.name = 'FlueError';
		this.type = options.type;
		this.details = options.details;
		this.dev = options.dev;
		this.meta = options.meta;
		this.cause = options.cause;
	}
}

interface FlueHttpErrorOptions extends FlueErrorOptions {
	/** HTTP status code (4xx or 5xx). */
	status: number;
	/** Additional response headers (e.g. `Allow` for 405). */
	headers?: Record<string, string>;
}

/**
 * Base class for HTTP-layer errors. Adds `status` and optional `headers`.
 * Subclasses set these in the `super({...})` call so the call site doesn't
 * have to think about HTTP semantics.
 */
class FlueHttpError extends FlueError {
	readonly status: number;
	readonly headers: Record<string, string> | undefined;

	constructor(options: FlueHttpErrorOptions) {
		super(options);
		this.name = 'FlueHttpError';
		this.status = options.status;
		this.headers = options.headers;
	}
}

// ─── HTTP-layer error vocabulary ────────────────────────────────────────────

export class RuntimeUnavailableError extends FlueHttpError {
	constructor({ state }: { state: 'loading' | 'draining' | 'failed' }) {
		super({
			type: 'runtime_unavailable',
			message: 'The local runtime is temporarily unavailable.',
			details: 'Retry after the runtime finishes reloading.',
			dev: '',
			status: 503,
			headers: { 'Retry-After': '1' },
			meta: { state },
		});
	}
}

export class MethodNotAllowedError extends FlueHttpError {
	constructor({ method, allowed }: { method: string; allowed: readonly string[] }) {
		super({
			type: 'method_not_allowed',
			message: `HTTP method ${method} is not allowed on this endpoint.`,
			details: `This endpoint accepts ${formatList(allowed)} only.`,
			dev: '',
			status: 405,
			headers: { Allow: allowed.join(', ') },
		});
	}
}

class UnsupportedMediaTypeError extends FlueHttpError {
	constructor({ received }: { received: string | null }) {
		const detailLines: string[] = [];
		if (received) {
			detailLines.push(`Received Content-Type: "${received}".`);
		} else {
			detailLines.push(`No Content-Type header was sent.`);
		}
		detailLines.push(
			`Send the request body as JSON with the header "Content-Type: application/json", ` +
				`or omit the body entirely (and the Content-Type header) if the request doesn't have a payload.`,
		);
		super({
			type: 'unsupported_media_type',
			message: `Request body must be sent as application/json.`,
			details: detailLines.join('\n'),
			dev: '',
			status: 415,
		});
	}
}

class InvalidJsonError extends FlueHttpError {
	constructor({ parseError }: { parseError: string }) {
		super({
			type: 'invalid_json',
			message: `Request body is not valid JSON.`,
			// `parseError` here describes the caller's own input (e.g. "Expected
			// property name at position 1") and is safe to expose. It's about
			// what the caller sent, not about server internals.
			details:
				`The JSON parser reported: ${parseError}\n` +
				`Verify the body is well-formed JSON, or omit the body entirely if the request doesn't have a payload.`,
			dev: '',
			status: 400,
		});
	}
}

class AgentNotFoundError extends FlueHttpError {
	constructor({ name, available }: { name: string; available: readonly string[] }) {
		super({
			type: 'agent_not_found',
			message: `Agent "${name}" is not registered.`,
			// Caller-safe: no enumeration, no framework internals.
			details: `Verify the agent name is correct.`,
			// Dev-only: sibling enumeration and project-root mechanics. Useful
			// for the human running the service; would leak namespace state
			// or framework details to a public caller.
			dev:
				`Available agents: ${formatList(available)}.\n` +
				`Agents are loaded from the project root's "agents/" directory at build time. ` +
				`Verify the agent file is present in the project root being served.`,
			status: 404,
		});
	}
}

class WorkflowNotFoundError extends FlueHttpError {
	constructor({
		name,
		available,
		notHttp = false,
	}: {
		name: string;
		available: readonly string[];
		notHttp?: boolean;
	}) {
		super({
			type: 'workflow_not_found',
			message: `Workflow "${name}" is not registered.`,
			// Caller-safe and identical for unknown and non-HTTP workflows, so
			// public callers cannot enumerate internal-only workflow names by
			// probing /workflows/<name>.
			details: `Verify the workflow name is correct.`,
			dev: notHttp
				? `Workflow "${name}" is built but not exposed over HTTP. ` +
					`To expose it, export route middleware and call await next() to enter the workflow handler.`
				: `Available workflows: ${formatList(available)}.\n` +
					`Workflows are loaded from the project root's "workflows/" directory at build time.`,
			status: 404,
		});
	}
}

export class RouteNotFoundError extends FlueHttpError {
	constructor({ method, path }: { method: string; path: string }) {
		super({
			type: 'route_not_found',
			message: `No route matches ${method} ${path}.`,
			// Thrown for any unmatched path (agent, workflow, run, or
			// otherwise), so the guidance stays generic and we do NOT
			// enumerate registered routes.
			details: `Verify the request method and path are correct.`,
			dev: '',
			status: 404,
		});
	}
}

export class RunNotFoundError extends FlueHttpError {
	constructor({ runId }: { runId: string }) {
		super({
			type: 'run_not_found',
			message: `Run "${runId}" was not found.`,
			details: 'Verify the run id is correct and its history is still available.',
			dev: '',
			status: 404,
		});
	}
}

export class StreamNotFoundError extends FlueHttpError {
	constructor({ path }: { path: string }) {
		super({
			type: 'stream_not_found',
			message: `Event stream "${path}" was not found.`,
			details:
				'Streams are created when their agent instance receives its first prompt or their workflow run starts.',
			dev: '',
			status: 404,
		});
	}
}

export class RunStoreUnavailableError extends FlueHttpError {
	constructor() {
		super({
			type: 'run_store_unavailable',
			message: 'Run history is not available in this runtime.',
			details: 'This endpoint requires the generated runtime to be configured with a run store.',
			dev: '',
			status: 501,
		});
	}
}

export class InvalidRequestError extends FlueHttpError {
	constructor({ reason }: { reason: string }) {
		super({
			type: 'invalid_request',
			message: `Request is malformed.`,
			// `reason` is provided by the caller's own input (URL shape,
			// segment validation, etc.) and is caller-safe by construction.
			details: reason,
			dev: '',
			status: 400,
		});
	}
}

// ─── Persistence error vocabulary ───────────────────────────────────────────

/**
 * A persisted store records a schema/format version this runtime does not
 * support. Thrown when opening a database stamped by a newer Flue version
 * (e.g. after a rollback) or carrying an unrecognized version marker.
 *
 * Not an HTTP error — this fires when a store is opened (startup, adapter
 * `migrate()`, Durable Object initialization), before any request is served.
 */
export class ProductEventVersionError extends FlueError {
	constructor({ storedVersion }: { storedVersion: unknown }) {
		super({
			type: 'product_event_version_unsupported',
			message: `Persisted product event version ${String(storedVersion)} is unsupported.`,
			details: 'The persisted event cannot be read or replayed safely by this runtime.',
			dev: 'Clear historical event and terminal-outbox data created by an earlier Flue beta.',
			meta: { storedVersion, supportedVersion: 3 },
		});
	}
}

export class ConversationRecordInvariantError extends FlueError {
	constructor({
		recordId,
		recordType,
		reason,
	}: {
		recordId: string;
		recordType: string;
		reason: string;
	}) {
		super({
			type: 'conversation_record_invariant',
			message: 'A canonical conversation record violates the conversation stream contract.',
			details: 'The persisted conversation cannot be reduced safely.',
			dev: reason,
			meta: { recordId, recordType, reason },
		});
		this.name = 'ConversationRecordInvariantError';
	}
}

export class ConversationStreamStoreError extends FlueError {
	constructor({
		operation,
		path,
		reason,
	}: {
		operation: string;
		path: string;
		reason: string;
	}) {
		super({
			type: 'conversation_stream_store_failure',
			message: 'The canonical conversation stream operation could not be completed.',
			details: 'The conversation stream remains unchanged when the operation was rejected.',
			dev: reason,
			meta: { operation, path, reason },
		});
		this.name = 'ConversationStreamStoreError';
	}
}

export class AttachmentConflictError extends FlueError {
	constructor({ path, attachmentId }: { path: string; attachmentId: string }) {
		super({
			type: 'attachment_conflict',
			message: 'The attachment identity conflicts with persisted attachment data.',
			details: 'Use a new attachment identity or retry with the exact original attachment.',
			dev: `Attachment "${attachmentId}" in canonical stream "${path}" was reused with different content, metadata, or ownership.`,
			meta: { path, attachmentId },
		});
		this.name = 'AttachmentConflictError';
	}
}

export class AttachmentIntegrityError extends FlueError {
	constructor({ attachmentId, reason }: { attachmentId: string; reason: 'size' | 'digest' | 'chunks' }) {
		super({
			type: 'attachment_integrity',
			message: 'The attachment bytes failed integrity verification.',
			details: 'The attachment cannot be used safely.',
			dev: `Attachment "${attachmentId}" has a ${reason} mismatch.`,
			meta: { attachmentId, reason },
		});
		this.name = 'AttachmentIntegrityError';
	}
}

export class PersistedSchemaVersionError extends FlueError {
	constructor({
		storedVersion,
		supportedVersion,
	}: {
		storedVersion: string;
		supportedVersion: number;
	}) {
		const numeric = /^[0-9]+$/.test(storedVersion) ? Number(storedVersion) : undefined;
		const newer = numeric !== undefined && numeric > supportedVersion;
		super({
			type: 'persisted_schema_version_unsupported',
			message: newer
				? `This database was created by a newer Flue version (schema version ${storedVersion}; this runtime supports version ${supportedVersion}).`
				: `This database records an unrecognized schema version ("${storedVersion}"; this runtime supports version ${supportedVersion}).`,
			details: 'The persisted data cannot be read safely by this runtime.',
			dev: newer
				? `Upgrade Flue to a version that supports schema version ${storedVersion}, or point the runtime at a different database.`
				: `The "schema_version" row in the flue_meta table is not a version this runtime recognizes. ` +
					`Restore the database, or point the runtime at a different one.`,
			meta: { storedVersion, supportedVersion },
		});
	}
}

// ─── Sandbox error vocabulary ───────────────────────────────────────────────

export class InstrumentationAlreadyInstalledError extends FlueError {
	constructor() {
		super({
			type: 'instrumentation_already_installed',
			message: 'An instrumentation owner of this kind is already installed.',
			details: 'Dispose the active instrumentation before installing its replacement.',
			dev: '',
		});
		this.name = 'InstrumentationAlreadyInstalledError';
	}
}

export class SandboxOperationUnsupportedError extends FlueError {
	constructor({
		operation,
		provider,
		options,
	}: {
		operation: string;
		provider: string;
		options: readonly string[];
	}) {
		super({
			type: 'sandbox_operation_unsupported',
			message: `${provider} does not support ${operation} with ${formatList(options)}.`,
			details: 'The requested operation was rejected before the filesystem was modified.',
			dev: 'Use an adapter that implements these options exactly, or issue an operation supported by this provider.',
			meta: { operation, provider, options: [...options] },
		});
	}
}

// ─── Session error vocabulary ───────────────────────────────────────────────
//
// Non-HTTP errors thrown by the session surface: `harness.session()` /
// `harness.sessions.*` and `session.prompt()` / `skill()` / `task()` /
// `shell()` / `compact()`. Programmatic consumers (the primary
// audience of these calls) distinguish failures with `instanceof` against the
// classes re-exported from the package root. When one of these escapes to the
// HTTP layer (e.g. a `?wait=result` prompt), `toHttpResponse` renders its
// typed envelope with status 500 instead of an opaque `internal_error`.
//
// Aborted operations are NOT part of this vocabulary — they reject with a
// standard `AbortError` (`DOMException`); see `abort.ts`.

export class SessionNotFoundError extends FlueError {
	constructor({ session, harness }: { session: string; harness: string }) {
		super({
			type: 'session_not_found',
			message: `Session "${session}" does not exist in harness "${harness}".`,
			details: 'Verify the session name is correct, or create the session first.',
			dev: '`sessions.get()` never creates sessions. Use `harness.session(name)` to get-or-create, or `sessions.create(name)` to create explicitly.',
		});
	}
}

export class SessionAlreadyExistsError extends FlueError {
	constructor({ session, harness }: { session: string; harness: string }) {
		super({
			type: 'session_already_exists',
			message: `Session "${session}" already exists in harness "${harness}".`,
			details: 'Choose a different session name, or open the existing session instead.',
			dev: '`sessions.create()` requires an unused name. Use `harness.session(name)` to get-or-create.',
		});
	}
}

export class SessionBusyError extends FlueError {
	constructor({ session, activeOperation }: { session: string; activeOperation: string }) {
		super({
			type: 'session_busy',
			message: `Session "${session}" is busy running ${activeOperation}.`,
			details: 'Wait for the active operation to finish before starting another operation.',
			dev: 'Sessions run one operation at a time. Start another session for parallel conversation branches.',
		});
	}
}

export class SkillDefinitionValidationError extends FlueError {
	constructor({ issues }: { issues: readonly ValidationIssue[] }) {
		super({
			type: 'skill_definition_validation',
			message: 'Skill definition is invalid.',
			details: 'Correct the invalid skill fields and try again.',
			dev: 'Pass a valid Agent Skills definition to defineSkill().',
			meta: { issues },
		});
		this.name = 'SkillDefinitionValidationError';
	}
}

export class SkillNotRegisteredError extends FlueError {
	constructor({
		skill,
		available,
		skillsDir,
	}: {
		skill: string;
		available: readonly string[];
		skillsDir: string;
	}) {
		super({
			type: 'skill_not_registered',
			message: `Skill "${skill}" is not registered.`,
			details: 'Verify the skill name is correct.',
			dev:
				`Available skills: ${formatList(available)}.\n` +
				`Skills are discovered at init() time from ${skillsDir}/<name>/SKILL.md inside the ` +
				`session's sandbox. If you expected "${skill}" to be there, make sure the SKILL.md file ` +
				`exists at that path before calling init() — the default empty sandbox starts with no ` +
				`files, so it has no skills unless you put them there.\n` +
				`Packaged skills can be imported from SKILL.md with { type: 'skill' } and passed ` +
				`directly to session.skill(skillReference).`,
		});
	}
}

export class ProviderRegistrationError extends FlueError {
	constructor({ providerId }: { providerId: string }) {
		super({
			type: 'invalid_provider_registration',
			message: `Provider "${providerId}" cannot be registered without \`api\` and \`baseUrl\`.`,
			details: `"${providerId}" is not a catalog provider, so its registration must say which wire protocol and endpoint to use.`,
			dev:
				'Pass `api` and `baseUrl` in the registerProvider() options. They are only optional ' +
				'when the provider id is a built-in catalog provider, in which case the registration ' +
				'hydrates from the catalog.',
			meta: { providerId },
		});
	}
}

export class ModelNotConfiguredError extends FlueError {
	constructor({ callSite }: { callSite: string }) {
		super({
			type: 'model_not_configured',
			message: `No model is configured for ${callSite}.`,
			details: '',
			dev: 'Pass `{ model: "provider-id/model-id" }` to the call, or configure a model on the agent definition.',
		});
	}
}

export class DelegationDepthExceededError extends FlueError {
	constructor({ maxDepth }: { maxDepth: number }) {
		super({
			type: 'delegation_depth_exceeded',
			message: `Maximum delegation depth (${maxDepth}) exceeded.`,
			details: 'The chain of delegated Tasks and Actions is too deep.',
			dev: 'Each nested task() or Action delegation adds one level. Restructure the agents to delegate less deeply.',
		});
	}
}

export class SubagentNotDeclaredError extends FlueError {
	constructor({ subagent, available }: { subagent: string; available: readonly string[] }) {
		super({
			type: 'subagent_not_declared',
			message: `Subagent "${subagent}" is not declared.`,
			details: 'Verify the subagent name is correct.',
			dev:
				`Available subagents: ${formatList(available)}.\n` +
				"Declare subagents in the agent definition's `subagents` array.",
		});
	}
}

export class AttachmentNotAvailableError extends FlueError {
	constructor({ attachmentId }: { attachmentId: string }) {
		super({
			type: 'attachment_not_available',
			message: `Attachment "${attachmentId}" is not available in this session.`,
			details: 'The delegated task can only receive attachments visible in its calling session.',
			dev: 'Pass an attachment ID from the current conversation attachment manifest.',
			meta: { attachmentId },
		});
	}
}

export class ToolNameConflictError extends FlueError {
	constructor({
		name,
		conflict,
		source,
		reserved,
	}: {
		name: string;
		conflict: 'reserved' | 'duplicate';
		source: 'builtin' | 'adapter' | 'framework' | 'custom' | 'action' | 'result';
		reserved?: readonly string[];
	}) {
		const dev =
			source === 'adapter'
				? conflict === 'reserved'
					? `The sandbox adapter's tools() returned "${name}", which the framework appends ` +
						'automatically when appropriate; remove it from the adapter.'
					: `The sandbox adapter's tools() returned the name "${name}" more than once; ` +
						'sandbox adapter tool names must be unique.'
				: conflict === 'reserved'
					? `Framework-reserved tool names: ${formatList(reserved ?? [])}. Rename the custom tool.`
					: 'Rename one of the conflicting custom tools.';
		super({
			type: 'tool_name_conflict',
			message:
				conflict === 'reserved'
					? `Tool name "${name}" is reserved by the framework.`
					: `Duplicate tool name "${name}".`,
			details: 'Tool names must be unique and must not use framework-reserved names.',
			dev,
		});
	}
}

/**
 * One validation failure from a tool-arguments schema, in Standard Schema's
 * issues shape (https://standardschema.dev). `path` segments are the property
 * keys leading to the failing value.
 */
export interface ValidationIssue {
	readonly message: string;
	readonly path?: readonly PropertyKey[];
}

export type ToolValidationIssue = ValidationIssue;

abstract class ActionValidationError extends FlueError {
	constructor({
		action,
		boundary,
		issues,
	}: {
		action: string;
		boundary: 'input' | 'output';
		issues: readonly ValidationIssue[];
	}) {
		super({
			type: `action_${boundary}_validation`,
			message: `Action "${action}" ${boundary} does not match the required schema.`,
			details: '',
			dev: '',
			meta: { action, issues },
		});
	}
}

export class ActionInputValidationError extends ActionValidationError {
	constructor({ action, issues }: { action: string; issues: readonly ValidationIssue[] }) {
		super({ action, boundary: 'input', issues });
		this.name = 'ActionInputValidationError';
	}
}

export class ActionOutputValidationError extends ActionValidationError {
	constructor({ action, issues }: { action: string; issues: readonly ValidationIssue[] }) {
		super({ action, boundary: 'output', issues });
		this.name = 'ActionOutputValidationError';
	}
}

export class ActionOutputSerializationError extends FlueError {
	constructor({ action, cause }: { action: string; cause?: unknown }) {
		super({
			type: 'action_output_serialization',
			message: `Action "${action}" output is not JSON-serializable.`,
			details: '',
			dev: 'Return a JSON-serializable value, or undefined when the Action has no output schema.',
			meta: { action },
			cause,
		});
		this.name = 'ActionOutputSerializationError';
	}
}

export class WorkflowInvocationNotConfiguredError extends FlueError {
	constructor() {
		super({
			type: 'workflow_invocation_not_configured',
			message: 'Workflow invocation is not configured in this runtime.',
			details: '',
			dev: 'Call invoke() from a Flue-built server entry.',
		});
		this.name = 'WorkflowInvocationNotConfiguredError';
	}
}

export class WorkflowNotDiscoveredError extends FlueError {
	constructor() {
		super({
			type: 'workflow_not_discovered',
			message: 'The workflow is not registered in this application.',
			details: '',
			dev: 'invoke() accepts the exact Workflow Definition value default-exported by one discovered workflow module.',
		});
		this.name = 'WorkflowNotDiscoveredError';
	}
}

export class WorkflowInputUnexpectedError extends FlueError {
	constructor() {
		super({
			type: 'workflow_input_unexpected',
			message: 'This workflow does not accept input.',
			details: '',
			dev: 'Remove the input value from invoke() for a workflow whose Action has no input schema.',
		});
		this.name = 'WorkflowInputUnexpectedError';
	}
}

export class WorkflowInputSerializationError extends FlueError {
	constructor({ cause }: { cause: unknown }) {
		super({
			type: 'workflow_input_serialization',
			message: 'Workflow input is not JSON-serializable.',
			details: '',
			dev: 'Pass a plain JSON value as invoke().input.',
			cause,
		});
		this.name = 'WorkflowInputSerializationError';
	}
}

export class WorkflowAdmissionUnavailableError extends FlueError {
	constructor() {
		super({
			type: 'workflow_admission_unavailable',
			message: 'Workflow admission is not available in this runtime.',
			details: '',
			dev: 'The generated runtime did not configure a workflow admission hook.',
		});
		this.name = 'WorkflowAdmissionUnavailableError';
	}
}

export class WorkflowAdmissionError extends FlueError {
	constructor({ workflow, cause }: { workflow: string; cause: unknown }) {
		super({
			type: 'workflow_admission_failed',
			message: 'Workflow admission failed.',
			details: '',
			dev: `The generated runtime could not admit workflow "${workflow}".`,
			meta: { workflow },
			cause,
		});
		this.name = 'WorkflowAdmissionError';
	}
}

/**
 * Model-supplied tool arguments failed the tool's valibot `parameters`
 * schema. Thrown from the tool's wrapped `execute`; the agent loop converts
 * the throw into an error tool-result built from `message`, so the model sees
 * the issues and can retry with corrected arguments. `meta.issues` carries
 * the structured issues in Standard Schema's shape.
 */
export class ToolLegacyDefinitionError extends FlueError {
	constructor({ fields }: { fields: readonly string[] }) {
		super({
			type: 'tool_legacy_definition',
			message: 'This tool uses the unsupported legacy definition format.',
			details: 'The tool definition contains legacy fields.',
			dev:
				'defineTool() no longer supports { parameters, execute }. Rename parameters to input, rename execute to run, and return structured data directly. Flue validates output and JSON-serializes it for the model.',
			meta: { fields: [...fields] },
		});
		this.name = 'ToolLegacyDefinitionError';
	}
}

export class ToolInputValidationError extends FlueError {
	constructor({ tool, issues }: { tool: string; issues: readonly ToolValidationIssue[] }) {
		const summary = issues
			.map((issue) =>
				issue.path && issue.path.length > 0
					? `${issue.message} (at ${issue.path.map(String).join('.')})`
					: issue.message,
			)
			.join('; ');
		super({
			type: 'tool_input_validation',
			message:
				`Arguments for tool "${tool}" do not match the required schema: ${summary}. ` +
				'Call the tool again with corrected arguments.',
			details: '',
			dev: '',
			meta: { tool, issues },
		});
		this.name = 'ToolInputValidationError';
	}
}

export class ToolOutputValidationError extends FlueError {
	constructor({ tool, issues }: { tool: string; issues: readonly ToolValidationIssue[] }) {
		super({
			type: 'tool_output_validation',
			message: `Tool "${tool}" output does not match the required schema.`,
			details: '',
			dev: '',
			meta: { tool, issues },
		});
		this.name = 'ToolOutputValidationError';
	}
}

export class ToolOutputSerializationError extends FlueError {
	constructor({ tool, cause }: { tool: string; cause?: unknown }) {
		super({
			type: 'tool_output_serialization',
			message: `Tool "${tool}" output is not JSON-serializable.`,
			details: '',
			dev: 'Return a JSON-serializable value, or undefined when the Tool has no output schema.',
			meta: { tool },
			cause,
		});
		this.name = 'ToolOutputSerializationError';
	}
}

/**
 * A session operation ran but did not complete successfully — the underlying
 * model call errored, or a durable input could not be persisted or recovered.
 * `reason` carries the underlying failure text; it is part of the message so
 * logs and serialized events stay informative, but it is prose, not API.
 */
export class OperationFailedError extends FlueError {
	constructor({ operation, reason }: { operation: string; reason: string }) {
		super({
			type: 'operation_failed',
			message: `${operation} failed: ${reason}`,
			details: '',
			dev: '',
		});
	}
}

/**
 * A durable submission was interrupted (process crash, restart, or shutdown)
 * and recovery settled it as failed because resuming or replaying the work
 * was not provably safe. `meta.phase` carries where the interruption left
 * the submission:
 *
 * - `'retry_exhausted_before_input'` — every attempt was interrupted while
 *   the submission was claimed but unstarted, and the shared attempt budget
 *   ran out. No provider work ever happened, so the generic retry-exhaustion
 *   error would misdescribe the failure; the shared `attemptCount`/
 *   `maxAttempts` budget itself is intentional.
 * - `'before_input_marker'` — interrupted with inconsistent pre-marker state
 *   that canonical replay could not safely repair.
 * - `'after_input_application'` — interrupted after input application
 *   without a completed response that recovery could safely resume. When the
 *   interruption left tool calls whose outcomes could not be confirmed,
 *   `meta.interruptedTools` lists them; an unresolved tool call is never
 *   assumed to have completed and is never retried automatically.
 */
export class SubmissionInterruptedError extends FlueError {
	constructor(
		input:
			| { phase: 'retry_exhausted_before_input'; attemptCount: number; maxAttempts: number }
			| { phase: 'before_input_marker' }
			| {
					phase: 'after_input_application';
					interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>;
			  },
	) {
		if (input.phase === 'retry_exhausted_before_input') {
			super({
				type: 'submission_interrupted',
				message:
					'Submission was repeatedly interrupted before input application and exhausted its retry budget.',
				details:
					'Every processing attempt was interrupted before the submission input was applied to the session. ' +
					'The input was never processed and no model call was started.',
				dev:
					'Repeated pre-input interruptions usually mean the process kept restarting or crashing while the ' +
					"submission waited to start. Each claim consumes one attempt from the agent definition's " +
					'`durability.maxAttempts` budget.',
				meta: {
					phase: input.phase,
					attemptCount: input.attemptCount,
					maxAttempts: input.maxAttempts,
				},
			});
		} else if (input.phase === 'before_input_marker') {
			super({
				type: 'submission_interrupted',
				message: 'Submission was interrupted before input application could be safely recovered.',
				details:
					'The canonical conversation and operational marker did not provide a safe recoverable input state. ' +
					'The input was not replayed.',
				dev: '',
				meta: { phase: input.phase },
			});
		} else {
			const toolNames = input.interruptedTools?.map((tool) => tool.name) ?? [];
			super({
				type: 'submission_interrupted',
				message:
					toolNames.length > 0
						? `Submission was interrupted with pending tool call(s): ${toolNames.join(', ')}. ` +
							'The tool outcome could not be confirmed and the tool was not automatically retried.'
						: 'Submission was interrupted after input application without a completed response. ' +
							'The work was not automatically replayed.',
				details:
					'Recovery settles interrupted work as failed when it cannot prove that resuming or replaying is ' +
					'safe: a repeated model or tool call could duplicate external effects.',
				dev: '',
				meta: {
					phase: input.phase,
					...(input.interruptedTools ? { interruptedTools: input.interruptedTools } : {}),
				},
			});
		}
	}
}

/**
 * A durable submission exhausted its recovery attempt budget after its input
 * was applied: repeated attempts (interruption, restart, or transient
 * failure) consumed `maxAttempts` without a completed response.
 */
export class SubmissionRetryExhaustedError extends FlueError {
	constructor({ attemptCount, maxAttempts }: { attemptCount: number; maxAttempts: number }) {
		super({
			type: 'submission_retry_exhausted',
			message: `Submission exceeded maximum recovery attempts (${attemptCount}/${maxAttempts}).`,
			details:
				'Recovery re-attempted the interrupted submission until its attempt budget ran out without a ' +
				'completed response.',
			dev: "The budget is configured via the agent definition's `durability.maxAttempts`.",
			meta: { attemptCount, maxAttempts },
		});
	}
}

export class SubmissionOwnershipError extends FlueError {
	constructor({ boundary }: { boundary: string }) {
		super({
			type: 'submission_ownership_lost',
			message: 'Submission ownership was lost before external work could continue.',
			details: 'The interrupted attempt did not invoke additional model or tool work.',
			dev: `The durable ownership transition failed at "${boundary}".`,
			meta: { boundary },
		});
	}
}

/** A durable submission exceeded its configured processing timeout. */
export class SubmissionTimeoutError extends FlueError {
	constructor() {
		super({
			type: 'submission_timeout',
			message: 'Submission exceeded the configured timeout.',
			details: 'The operation ran longer than the configured durability timeout.',
			dev: "The timeout is configured in milliseconds via the agent definition's `durability.timeoutMs`.",
		});
	}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ERROR FRAMEWORK UTILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Error framework utilities: renderers, type guards, request parsing helpers.
 *
 * Wire envelope (HTTP body + SSE `data:` payload for error events):
 *
 *     {
 *       "error": {
 *         "type":    "...",
 *         "message": "...",
 *         "details": "...",
 *         "dev":     "..."   // present only in local/dev mode AND when non-empty
 *       }
 *     }
 *
 * Field rules:
 *   - `type`, `message`, `details` are always present on the wire.
 *   - `dev` is gated by explicit generated-runtime configuration. Even in
 *     local development, `dev` is omitted when the error class set it to
 *     `''` — so its presence is not a reliable signal of mode by itself;
 *     clients should not depend on it that way.
 *     See the error classes above for the two-audience rationale.
 *   - `meta` is included on the wire only when an error subclass sets it
 *     (rare).
 *   - `cause` is never included on the wire (it's logged server-side only).
 */

function isFlueError(value: unknown): value is FlueError {
	return value instanceof FlueError;
}

/**
 * Module-private for now: when an external call site appears we can promote
 * to `export` and decide the right shape for `warn`/`info` (FlueError
 * subclasses with severity? plain strings? structured data?) — rather than
 * committing to a shape now without any usage to validate it.
 */
function formatForLog(prefix: string, err: unknown): string {
	if (isFlueError(err)) {
		// Server-side logs always show every audience's prose. Mode gating
		// only applies to the wire envelope.
		const lines: string[] = [`${prefix} [${err.type}] ${err.message}`];
		if (err.details) {
			for (const line of err.details.split('\n')) {
				lines.push(`  ${line}`);
			}
		}
		if (err.dev) {
			for (const line of err.dev.split('\n')) {
				lines.push(`  ${line}`);
			}
		}
		if (err.cause !== undefined) {
			lines.push(
				`  cause: ${err.cause instanceof Error ? (err.cause.stack ?? err.cause.message) : String(err.cause)}`,
			);
		}
		return lines.join('\n');
	}
	if (err instanceof Error) {
		return `${prefix} ${err.stack ?? err.message}`;
	}
	return `${prefix} ${String(err)}`;
}

const flueLog = {
	error(err: unknown): void {
		console.error(formatForLog('[flue]', err));
	},
};

interface WireEnvelope {
	error: {
		type: string;
		message: string;
		details: string;
		dev?: string;
		meta?: Record<string, unknown>;
	};
}

let devMode = false;

export function configureErrorRendering(options: { devMode: boolean }): void {
	devMode = options.devMode;
}

function envelope(err: FlueError): WireEnvelope {
	const out: WireEnvelope = {
		error: {
			type: err.type,
			message: err.message,
			details: err.details,
		},
	};
	// `dev` is included only when the server is in dev mode AND the error
	// class actually populated it. Some errors (MethodNotAllowedError,
	// InvalidJsonError, …) intentionally set `dev: ''` because everything
	// useful is already in `details` — those render the same in dev and
	// prod. So `dev`'s presence on the wire is NOT a reliable mode signal;
	// it just means "this error has dev-only guidance to share."
	if (devMode && err.dev) out.error.dev = err.dev;
	if (err.meta) out.error.meta = err.meta;
	return out;
}

const GENERIC_INTERNAL: WireEnvelope = {
	error: {
		type: 'internal_error',
		message: 'An internal error occurred.',
		details: 'The server encountered an unexpected error while handling this request.',
	},
};

/**
 * Render any thrown value into a `Response` with the canonical Flue error
 * envelope. Unknown / non-Flue errors are logged in full and rendered as a
 * generic 500 with no message leaked.
 */
export function toHttpResponse(err: unknown): Response {
	// Browser security headers (DS protocol §12.7) — set on every error
	// response so stream-endpoint errors thrown before the protocol layer
	// (e.g. run lookups) still carry them.
	const baseHeaders: Record<string, string> = {
		'content-type': 'application/json',
		'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'cross-origin',
	};
	if (isFlueError(err)) {
		const isHttp = err instanceof FlueHttpError;
		const status = isHttp ? err.status : 500;
		const headers = { ...baseHeaders };
		if (isHttp && err.headers) {
			Object.assign(headers, err.headers);
		}
		// Log non-HTTP FlueErrors that bubbled up to the HTTP layer — they
		// weren't constructed with HTTP semantics in mind, so it's worth
		// surfacing them in logs even though we render their message.
		if (!isHttp) {
			flueLog.error(err);
		}
		return new Response(JSON.stringify(envelope(err)), { status, headers });
	}
	// Non-FlueError: log everything, leak nothing.
	flueLog.error(err);
	return new Response(JSON.stringify(GENERIC_INTERNAL), {
		status: 500,
		headers: baseHeaders,
	});
}

// These are HTTP-layer helpers that throw the concrete error subclasses defined
// above. They live here (rather than with the error classes) because they're
// framework utilities, not error definitions.

/**
 * Parse a request body as JSON. Returns `undefined` when the body is omitted.
 *
 * Throws `UnsupportedMediaTypeError` if a body is present without
 * `application/json` content-type, and `InvalidJsonError` if the body is
 * present but unparseable.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
	const contentLengthHeader = request.headers.get('content-length');
	const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
	const contentType = request.headers.get('content-type');
	const looksEmpty = contentLength === 0 || (contentLengthHeader === null && contentType === null);
	if (looksEmpty) return undefined;

	if (!contentType?.toLowerCase().includes('application/json')) {
		throw new UnsupportedMediaTypeError({ received: contentType });
	}

	let text: string;
	try {
		text = await request.clone().text();
	} catch (err) {
		throw new InvalidJsonError({
			parseError: err instanceof Error ? err.message : String(err),
		});
	}

	if (text.trim() === '') return undefined;

	try {
		return JSON.parse(text);
	} catch (err) {
		throw new InvalidJsonError({
			parseError: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Validate that a request targeting `/agents/<name>/<id>` is well-formed:
 * method is POST, and agent name is registered. Throws the appropriate
 * FlueHttpError on any failure.
 *
 * Path/id validation is light: we reject empty or whitespace-only segments
 * but otherwise let the URL parser's segment splitting be the source of
 * truth. The Hono route pattern enforces the public path shape.
 */
export interface ValidateAgentRequestOptions {
	method: string;
	name: string;
	id: string;
	registeredAgents: readonly string[];
}

export interface ValidateWorkflowRequestOptions {
	method: string;
	name: string;
	registeredWorkflows: readonly string[];
	httpWorkflows: readonly string[];
}

export function validateWorkflowRequest(opts: ValidateWorkflowRequestOptions): void {
	if (opts.method !== 'POST') {
		throw new MethodNotAllowedError({ method: opts.method, allowed: ['POST'] });
	}
	if (opts.name.trim() === '') {
		throw new InvalidRequestError({
			reason: 'Workflow URLs must have the shape /workflows/<name> with a non-empty segment.',
		});
	}
	if (!opts.registeredWorkflows.includes(opts.name)) {
		throw new WorkflowNotFoundError({ name: opts.name, available: opts.registeredWorkflows });
	}
	if (!opts.httpWorkflows.includes(opts.name)) {
		throw new WorkflowNotFoundError({
			name: opts.name,
			available: opts.registeredWorkflows,
			notHttp: true,
		});
	}
}

export function validateAgentRequest(opts: ValidateAgentRequestOptions): void {
	if (opts.method !== 'POST' && opts.method !== 'GET' && opts.method !== 'HEAD') {
		throw new MethodNotAllowedError({ method: opts.method, allowed: ['GET', 'HEAD', 'POST'] });
	}
	if (opts.name.trim() === '' || opts.id.trim() === '') {
		throw new InvalidRequestError({
			reason: 'Agent URLs must have the shape /agents/<name>/<id> with non-empty segments.',
		});
	}
	if (!opts.registeredAgents.includes(opts.name)) {
		throw new AgentNotFoundError({ name: opts.name, available: opts.registeredAgents });
	}
}
