/**
 * Complete error framework for Flue.
 *
 * This file contains both the error vocabulary (concrete error classes) and
 * the framework utilities (renderers, type guards, request parsing helpers).
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
 * Worked example (matches `SkillNotRegisteredError` below):
 *
 *     new SkillNotRegisteredError({ skill, available, skillsDir });
 *     // builds:
 *     //   message: `Skill "foo" is not registered.`
 *     //   details: `Verify the skill name is correct.`
 *     //   dev:     `Available skills: "echo", "greeter". Skills are
 *     //            discovered at init() time from skills/<name>/SKILL.md
 *     //            inside the session's sandbox. ...`
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
	constructor({ state, dev = '' }: { state: 'loading' | 'draining' | 'failed'; dev?: string }) {
		super({
			type: 'runtime_unavailable',
			message: 'The local runtime is temporarily unavailable.',
			details: 'Retry after the runtime finishes reloading.',
			// Local dev servers pass the underlying load failure here, so the
			// requester sees WHY the runtime is unavailable, not just that it is.
			dev,
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

export class RouteNotFoundError extends FlueHttpError {
	constructor({ method, path }: { method: string; path: string }) {
		super({
			type: 'route_not_found',
			message: `No route matches ${method} ${path}.`,
			// Thrown for any unmatched path, so the guidance stays generic and
			// we do NOT enumerate registered routes.
			details: `Verify the request method and path are correct.`,
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
			details: 'Streams are created when their agent instance receives its first prompt.',
			dev: '',
			status: 404,
		});
	}
}

export class AttachmentNotFoundError extends FlueHttpError {
	constructor({ attachmentId }: { attachmentId: string }) {
		super({
			type: 'attachment_not_found',
			message: `Attachment "${attachmentId}" was not found.`,
			details:
				'The attachment id may be incorrect, or it belongs to a conversation other than the default one.',
			dev: '',
			status: 404,
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

/**
 * A conditional send (`uid: '<value>'` — continue only the known
 * incarnation) named an instance that does not exist or whose uid does not
 * match. Raised synchronously at admission; nothing durable is created.
 * Also the rejection of a handle `read()` addressed to an instance that
 * does not exist — a read waits for settlement, and an instance that was
 * never contacted has nothing to settle.
 */
export class AgentInstanceNotFoundError extends FlueHttpError {
	constructor({ id }: { id: string }) {
		super({
			type: 'agent_instance_not_found',
			message: `Agent instance "${id}" was not found.`,
			// One message for absent-instance and uid-mismatch: to a caller
			// holding a uid condition, "the incarnation you know" not existing
			// is the same outcome either way.
			details:
				'No instance with this id and uid exists. The id may be wrong, or the instance was re-created and this uid names its previous incarnation. Send without a uid to deliver unconditionally.',
			dev: '',
			status: 404,
		});
	}
}

/**
 * A conditional send (`uid: null` — create only when fresh) named an
 * instance that already exists. Raised synchronously at admission; nothing
 * durable is created. `details` hands back the existing uid — the condition
 * is accident prevention for the caller, not access control — so the caller
 * can continue the existing instance without a separate lookup.
 */
export class AgentInstanceExistsError extends FlueHttpError {
	constructor({ id, uid }: { id: string; uid: string }) {
		super({
			type: 'agent_instance_exists',
			message: `Agent instance "${id}" already exists.`,
			details: `Continue it with uid "${uid}", or pick a fresh id to create.`,
			dev: '',
			status: 409,
			// HTTP callers read the existing incarnation's uid from
			// `error.meta.uid` — the details prose is not machine-readable.
			meta: { uid },
		});
		this.uid = uid;
	}

	/** The existing instance's uid. */
	readonly uid: string;
}

// ─── Persistence error vocabulary ───────────────────────────────────────────

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
	constructor({ operation, path, reason }: { operation: string; path: string; reason: string }) {
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
	constructor({
		attachmentId,
		reason,
	}: {
		attachmentId: string;
		reason: 'size' | 'digest' | 'chunks';
	}) {
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

/**
 * A sandbox call was in flight when the sandbox died, so the call can never
 * complete. Raised by a sandbox adapter's death detection: when a provider
 * transport leaves in-flight calls pending forever after the sandbox dies,
 * the adapter watches sandbox state while a call is pending and rejects with
 * this error — either because the provider reports the sandbox stopped
 * (`reason: 'stopped'`) or because the state probe itself went unanswered and
 * the sandbox is presumed gone (`reason: 'probe_silent'`).
 *
 * Deliberately not an `AbortError`: sandbox death is an infrastructure
 * failure, not caller cancellation, and abort classification must not
 * misreport it.
 */
export class SandboxDiedError extends FlueError {
	constructor({ operation, reason }: { operation: string; reason: 'stopped' | 'probe_silent' }) {
		super({
			type: 'sandbox_died',
			message:
				reason === 'stopped'
					? `Sandbox ${operation} failed: the sandbox stopped while the call was in flight.`
					: `Sandbox ${operation} failed: the sandbox state probe went unanswered while the call was in flight, so the sandbox is presumed dead.`,
			details: 'The sandbox is no longer running; the interrupted call did not complete.',
			dev:
				'The sandbox may have been destroyed, evicted, or crashed (e.g. out of memory). ' +
				'Only calls that were in flight when the sandbox died fail this way; whether a ' +
				'subsequent call reaches a fresh environment is provider-specific.',
			meta: { operation, reason },
		});
		this.name = 'SandboxDiedError';
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
// Non-HTTP errors thrown by the session surface: the harness's
// `prompt()` / `skill()` / `task()` / `shell()` / `compact()` operations
// and the runtime's internal session management. Programmatic consumers (the primary
// audience of these calls) distinguish failures with `instanceof` against the
// classes re-exported from the package root. When one of these escapes to the
// HTTP layer, `toHttpResponse` renders its typed envelope with status 500
// instead of an opaque `internal_error`.
//
// Aborted operations are NOT part of this vocabulary — they reject with a
// standard `AbortError` (`DOMException`); see `abort.ts`.

export class SessionNotFoundError extends FlueError {
	constructor({ session, harness }: { session: string; harness: string }) {
		super({
			type: 'session_not_found',
			message: `Session "${session}" does not exist in harness "${harness}".`,
			details: 'Verify the session name is correct, or create the session first.',
			dev: 'Internal session lookup found no conversation for this name. The public harness operations get-or-create the default session and cannot hit this.',
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
		/** Workspace skill directory; absent when the agent has no sandbox. */
		skillsDir?: string;
	}) {
		super({
			type: 'skill_not_registered',
			message: `Skill "${skill}" is not registered.`,
			details: 'Verify the skill name is correct.',
			dev:
				`Available skills: ${formatList(available)}.\n` +
				(skillsDir !== undefined
					? `Skills are discovered at init() time from ${skillsDir}/<name>/SKILL.md inside the ` +
						`session's sandbox. If you expected "${skill}" to be there, make sure the SKILL.md file ` +
						`exists at that path before calling init().\n`
					: `This agent has no sandbox, so no workspace skills were discovered — only declared ` +
						`skills are available.\n`) +
				`Packaged skills can be imported from SKILL.md and passed ` +
				`directly to session.skill(skillReference).`,
		});
	}
}

/**
 * Marker appended to a Workers-AI binding 413 error message. Overflow
 * classification reads the persisted assistant `errorMessage` — no typed
 * error object exists at that point — so the marker is the transport, and
 * `isAssistantContextOverflow` (compaction.ts) matches it against this same
 * constant. Keep writer and reader on this one definition.
 */
export const WORKERS_AI_OVERFLOW_MARKER = '(request_too_large)';

/**
 * Marker stamped into a model error message by a throw site that can PROVE
 * the failure was a transient interruption — e.g. the Workers-AI stream
 * ending without an error frame or a `finish_reason`, so the response was
 * truncated in transit. Retry classification reads the persisted assistant
 * `errorMessage` — no typed error object survives to that point — so the
 * marker is the transport, and `isRetryableModelError`
 * (submission-state.ts) matches it against this same constant before
 * falling back to its message-pattern heuristics. Only stamp it where the
 * site verifies the interruption; "we don't know what happened" is not
 * retryable.
 */
export const RETRYABLE_INTERRUPTION_MARKER = '(retryable_interruption)';

export class CloudflareAIBindingError extends FlueError {
	constructor({
		message,
		status,
		statusText,
		body,
	}: {
		message?: string;
		status?: number;
		statusText?: string;
		body?: string;
	}) {
		const statusLabel =
			status === undefined ? undefined : `${status}${statusText ? ` ${statusText}` : ''}`;
		// The provider body and the 413 marker ride in the MESSAGE, not just
		// `details`: only the message reaches the assistant `errorMessage`
		// that overflow classification reads, so a 413/overflow body kept out
		// of it would leave context-overflow recovery (compaction + retry)
		// unable to fire.
		const boundedBody = body ? truncateProviderBody(body) : undefined;
		const overflowMarker = status === 413 ? ` ${WORKERS_AI_OVERFLOW_MARKER}` : '';
		super({
			type: 'cloudflare_ai_binding_error',
			message:
				message ??
				`Cloudflare AI binding request failed${statusLabel ? ` with ${statusLabel}` : ''}${overflowMarker}${
					boundedBody ? `: ${boundedBody}` : '.'
				}`,
			details: body ? `Provider response: ${body}` : '',
			dev: '',
			meta: {
				...(status !== undefined ? { status } : {}),
				...(statusText ? { statusText } : {}),
				// Structured "conversation outgrew the provider limit" signal:
				// lets telemetry separate expected, self-healing overflow from a
				// real binding outage without parsing the message.
				...(status === 413 ? { reason: 'request_too_large' } : {}),
			},
		});
	}
}

/** Bound a provider response body for embedding in an error message. */
function truncateProviderBody(body: string): string {
	const MAX = 2000;
	return body.length <= MAX ? body : `${body.slice(0, MAX)}… [truncated]`;
}

/**
 * Serialize an error for embedding in observable events (`operation`, `log`).
 * FlueErrors keep their structured identity (`type`) and diagnostic payload
 * (`details`, `meta`) — dropping them to bare name/message makes typed
 * failures (e.g. a record-invariant error's recordId/recordType/reason)
 * undiagnosable from telemetry.
 */
export function serializeEventError(error: unknown): unknown {
	if (error instanceof FlueError) {
		return {
			name: error.name,
			message: error.message,
			type: error.type,
			...(error.details ? { details: error.details } : {}),
			...(error.meta ? { meta: error.meta } : {}),
		};
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return error;
}

/**
 * Shape `log`-event attributes: a live `Error` under the `error` key becomes
 * its `serializeEventError` projection, so every emit path (session and
 * client context) publishes the same error shape — structured FlueError
 * identity kept, throw-site stack omitted (log events ride durable-shaped
 * event fields).
 */
export function normalizeLogAttributes(
	attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!attributes) return undefined;
	if (!(attributes.error instanceof Error)) return attributes;
	return { ...attributes, error: serializeEventError(attributes.error) };
}

/**
 * Classify an error for live observation `errorInfo`. Unlike
 * `serializeEventError` (whose output rides durable-shaped event fields),
 * this projection is in-process only, so it may carry the throw-site `stack`
 * — taken solely from real `Error` instances, never from arbitrary thrown
 * objects. `FlueError`s additionally keep their framework-owned `meta` so
 * observers get structured failure detail (e.g. validation issues) without
 * parsing the rendered message.
 */
export function classifyError(error: unknown): {
	type: string;
	name?: string;
	code?: string;
	message?: string;
	meta?: Record<string, unknown>;
	stack?: string;
} {
	const stackOf = (value: unknown): { stack?: string } =>
		value instanceof Error && typeof value.stack === 'string' && value.stack.length > 0
			? { stack: value.stack }
			: {};
	if (error instanceof DOMException && error.name === 'AbortError') {
		return { type: 'AbortError', name: error.name, message: error.message, ...stackOf(error) };
	}
	if (error instanceof FlueError) {
		return {
			type: error.type,
			name: error.name,
			message: error.message,
			...(error.meta ? { meta: error.meta } : {}),
			...stackOf(error),
		};
	}
	if (error && typeof error === 'object') {
		const value = error as { name?: unknown; code?: unknown; type?: unknown; message?: unknown };
		const name = typeof value.name === 'string' ? value.name : undefined;
		const code = typeof value.code === 'string' ? value.code : undefined;
		const type = typeof value.type === 'string' ? value.type : (code ?? name ?? '_OTHER');
		return {
			type,
			...(name === undefined ? {} : { name }),
			...(code === undefined ? {} : { code }),
			...(typeof value.message === 'string' ? { message: value.message } : {}),
			...stackOf(error),
		};
	}
	if (typeof error === 'string') return { type: '_OTHER', message: error };
	return { type: '_OTHER' };
}

export class DelegationDepthExceededError extends FlueError {
	constructor({ maxDepth }: { maxDepth: number }) {
		super({
			type: 'delegation_depth_exceeded',
			message: `Maximum delegation depth (${maxDepth}) exceeded.`,
			details: 'The chain of delegated tasks is too deep.',
			dev: 'Each nested task() or harness-tool delegation adds one level. Restructure the agents to delegate less deeply.',
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
		source: 'builtin' | 'adapter' | 'framework' | 'custom' | 'result';
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
 * `meta` carries the unwrapped `operation` and `reason` so telemetry can
 * classify and title from the underlying failure without parsing the prose.
 */
export class OperationFailedError extends FlueError {
	constructor({ operation, reason }: { operation: string; reason: string }) {
		super({
			type: 'operation_failed',
			message: `${operation} failed: ${reason}`,
			details: '',
			dev: '',
			meta: { operation, reason },
		});
	}
}

/**
 * A durable submission was repeatedly interrupted (process crash, restart,
 * or shutdown) while claimed but unstarted, and the shared attempt budget
 * ran out before its input was ever persisted. No provider work happened,
 * so the generic retry-exhaustion error would misdescribe the failure; the
 * shared `attemptCount`/`maxAttempts` budget itself is intentional.
 *
 * (Input application has no other failure phase: the canonical stream is
 * the single truth for it — a persisted input classifies and resumes, an
 * absent input requeues — so there is no marker/stream disagreement to
 * settle as an error.)
 */
export class SubmissionInterruptedError extends FlueError {
	constructor(input: {
		phase: 'retry_exhausted_before_input';
		attemptCount: number;
		maxAttempts: number;
	}) {
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
	}
}

/**
 * A durable submission exhausted its recovery attempt budget after its input
 * was applied: repeated attempts (interruption, restart, or transient
 * failure) consumed `maxAttempts` without a completed response. When
 * terminalization settled tool calls whose outcomes could not be confirmed,
 * `meta.interruptedTools` lists them; each has an explicit interrupted-error
 * outcome in the conversation and was never assumed complete or retried.
 */
export class SubmissionRetryExhaustedError extends FlueError {
	constructor({
		attemptCount,
		maxAttempts,
		interruptedTools,
	}: {
		attemptCount: number;
		maxAttempts: number;
		interruptedTools?: ReadonlyArray<{ readonly name: string; readonly id: string }>;
	}) {
		super({
			type: 'submission_retry_exhausted',
			message: `Submission exceeded maximum recovery attempts (${attemptCount}/${maxAttempts}).`,
			details:
				'Recovery re-attempted the interrupted submission until its attempt budget ran out without a ' +
				'completed response.',
			dev: "The budget is configured via the agent definition's `durability.maxAttempts`.",
			meta: {
				attemptCount,
				maxAttempts,
				...(interruptedTools ? { interruptedTools } : {}),
			},
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

/**
 * A durable submission was aborted. Abort is requested per agent instance
 * (`abort(name, id)`), stops all in-flight and queued work for that instance,
 * and is a distinct terminal outcome — not a failure. A submission that has
 * already settled (or committed its terminal record) is never aborted; an abort
 * that loses the race to a completed response settles as completed instead.
 *
 * Rejects a waiting `wait()` call and is recorded as the durable terminal
 * outcome: a `submission_aborted` conversation advisory (both kinds) plus, for
 * direct submissions, a `submission_settled` record with `outcome: 'aborted'`.
 */
export class SubmissionAbortedError extends FlueError {
	constructor() {
		super({
			type: 'submission_aborted',
			message: 'Submission was aborted.',
			details: 'The operation was stopped before it produced a completed response.',
			dev: '',
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

/**
 * The runtime-wide dev flag, as configured by the target bootstrap. Consulted
 * by `instrument()` for hot-reload replace semantics — under dev module
 * reloads, user module scope re-evaluates against a runtime module instance
 * that persisted.
 */
export function isDevMode(): boolean {
	return devMode;
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
