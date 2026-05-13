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
 *     local debugging). Sees `dev` in addition, but only when the server is
 *     running in local/dev mode (gated by `FLUE_MODE=local`).
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
 *                   fix instructions. Rendered ONLY when FLUE_MODE=local.
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
 *           dev: '',                                         // ✗ wasted channel
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

export interface FlueErrorOptions {
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
	 * when the server is running in local/dev mode (FLUE_MODE=local).
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

export interface FlueHttpErrorOptions extends FlueErrorOptions {
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
export class FlueHttpError extends FlueError {
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

export class UnsupportedMediaTypeError extends FlueHttpError {
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

export class InvalidJsonError extends FlueHttpError {
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

export class AgentNotFoundError extends FlueHttpError {
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

export class AgentNotWebhookError extends FlueHttpError {
	constructor({ name }: { name: string }) {
		super({
			type: 'agent_not_webhook',
			message: `Agent "${name}" is not web-accessible.`,
			details: `This endpoint is not exposed over HTTP.`,
			// Dev-only: source-code-level fix instructions for the agent
			// author. The HTTP caller can't act on this.
			dev:
				`This agent has no webhook trigger configured. ` +
				`To expose it, add a webhook trigger to its definition (\`triggers: { webhook: true }\`). ` +
				`Trigger-less agents remain invokable via "flue run" in local mode.`,
			status: 404,
		});
	}
}

export class RouteNotFoundError extends FlueHttpError {
	constructor({ method, path }: { method: string; path: string }) {
		super({
			type: 'route_not_found',
			message: `No route matches ${method} ${path}.`,
			// The webhook URL shape is part of the public contract, so it's
			// safe to mention. We do NOT enumerate other registered routes.
			details: `Webhook agents are served at POST /agents/<name>/<id>.`,
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
			details: 'Verify the run id is correct and still within retention.',
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
 *   - `dev` is gated by `FLUE_MODE === 'local'` (set by `flue run` and
 *     `flue dev --target node`). Even in dev mode, `dev` is omitted when
 *     the error class set it to `''` — so its presence is not a reliable
 *     signal of mode by itself; clients should not depend on it that way.
 *     See the error classes above for the two-audience rationale.
 *   - `meta` is included on the wire only when an error subclass sets it
 *     (rare).
 *   - `cause` is never included on the wire (it's logged server-side only).
 */

export function isFlueError(value: unknown): value is FlueError {
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
			lines.push(`  cause: ${err.cause instanceof Error ? (err.cause.stack ?? err.cause.message) : String(err.cause)}`);
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

/**
 * Detect whether the server is running in local/dev mode. Gates whether the
 * `dev` field is included on the wire — see the convention doc in the error
 * classes above.
 *
 * Currently keyed off the `FLUE_MODE=local` env var, which is set by
 * `flue run` and `flue dev --target node`. On Cloudflare workers there is
 * no global `process` and no current "local mode" plumbing for the worker —
 * so deployed CF and `flue dev --target cloudflare` both currently render
 * the prod envelope. Threading a dev-mode signal through to the worker
 * fetch handler is left as a follow-up.
 */
function isDevMode(): boolean {
	return typeof process !== 'undefined' && process.env?.FLUE_MODE === 'local';
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
	if (isDevMode() && err.dev) out.error.dev = err.dev;
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
	if (isFlueError(err)) {
		const isHttp = err instanceof FlueHttpError;
		const status = isHttp ? err.status : 500;
		const headers: Record<string, string> = {
			'content-type': 'application/json',
		};
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
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * Render any thrown value into a JSON string suitable for the `data:` line of
 * an SSE `error` event. Same envelope as `toHttpResponse`. Unknown / non-Flue
 * errors are logged and replaced with a generic envelope.
 */
export function toSseData(err: unknown): string {
	if (isFlueError(err)) {
		if (!(err instanceof FlueHttpError)) {
			flueLog.error(err);
		}
		return JSON.stringify({ type: 'error', ...envelope(err) });
	}
	flueLog.error(err);
	return JSON.stringify({ type: 'error', ...GENERIC_INTERNAL });
}

// These are HTTP-layer helpers that throw the concrete error subclasses defined
// above. They live here (rather than with the error classes) because they're
// framework utilities, not error definitions.

/**
 * Parse a request body as JSON. Returns `{}` for genuinely empty bodies
 * (Content-Length: 0 or missing) so that webhook agents which don't accept
 * a payload can be invoked without one.
 *
 * Throws `UnsupportedMediaTypeError` if a body is present without
 * `application/json` content-type, and `InvalidJsonError` if the body is
 * present but unparseable.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
	const contentLengthHeader = request.headers.get('content-length');
	const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
	const contentType = request.headers.get('content-type');

	// Genuinely empty body: legal, treated as `{}`. We accept both an explicit
	// Content-Length: 0 and the absence of any body indicator (some clients
	// omit Content-Length on empty POSTs).
	//
	// Trade-off: if a client sends a body but no Content-Length AND no
	// Content-Type, we silently treat the request as empty rather than
	// reading the stream to check. That's intentional — it preserves the
	// `curl -X POST <url>` "no payload" UX for agents that don't take input,
	// and a misconfigured client that sends a body without either header is
	// already broken in ways we can't recover from cleanly.
	const looksEmpty =
		contentLength === 0 ||
		(contentLengthHeader === null && contentType === null);
	if (looksEmpty) return {};

	// If a body is present, require application/json. This is strict on
	// purpose — webhook agents have no business receiving form-encoded or
	// plain-text payloads, and silently accepting them invites the kind of
	// drift this whole hardening pass is trying to eliminate.
	if (!contentType || !contentType.toLowerCase().includes('application/json')) {
		throw new UnsupportedMediaTypeError({ received: contentType });
	}

	// We label both stream-read failures and JSON-parse failures as
	// `invalid_json`. A separate `BodyReadError` would be more precise, but
	// neither runtime (Node + workerd) exposes the distinction in a way
	// that's actionable for the client — in both cases, the right fix is
	// "send a valid JSON body" — so a single error type is clearer.
	//
	// We consume a clone, not the original, so that handlers can still
	// access the request body via `ctx.req` (e.g. for HMAC verification
	// over the raw bytes). Cloning is lazy — the body stream is tee'd, not
	// copied — so the cost is the unread tee buffering until GC. Skipped
	// above for empty-body requests, where there's nothing to clone.
	let text: string;
	try {
		text = await request.clone().text();
	} catch (err) {
		throw new InvalidJsonError({
			parseError: err instanceof Error ? err.message : String(err),
		});
	}

	if (text.trim() === '') return {};

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
 * method is POST, agent name is registered, and (optionally) the agent is
 * webhook-accessible. Throws the appropriate FlueHttpError on any failure.
 *
 * Path/id validation is light: we reject empty or whitespace-only segments
 * but otherwise let the URL parser's segment splitting be the source of
 * truth. The Cloudflare partyserver layer additionally enforces shape via
 * `routeAgentRequest`; the Node Hono layer via route patterns.
 */
export interface ValidateAgentRequestOptions {
	method: string;
	name: string;
	id: string;
	registeredAgents: readonly string[];
	webhookAgents: readonly string[];
	/**
	 * If true, skip the webhook-accessibility check. Used by `flue run` /
	 * dev local mode where trigger-less agents are also invokable.
	 */
	allowNonWebhook?: boolean;
}

export function validateAgentRequest(opts: ValidateAgentRequestOptions): void {
	if (opts.method !== 'POST') {
		throw new MethodNotAllowedError({ method: opts.method, allowed: ['POST'] });
	}
	validateAgentIdentity(opts);
}

export function validateAgentRunRequest(opts: ValidateAgentRequestOptions): void {
	if (opts.method !== 'GET') {
		throw new MethodNotAllowedError({ method: opts.method, allowed: ['GET'] });
	}
	validateAgentIdentity(opts);
}

function validateAgentIdentity(opts: ValidateAgentRequestOptions): void {
	if (opts.name.trim() === '' || opts.id.trim() === '') {
		throw new InvalidRequestError({
			reason: 'Webhook URLs must have the shape /agents/<name>/<id> with non-empty segments.',
		});
	}
	if (!opts.registeredAgents.includes(opts.name)) {
		throw new AgentNotFoundError({ name: opts.name, available: opts.registeredAgents });
	}
	if (!opts.allowNonWebhook && !opts.webhookAgents.includes(opts.name)) {
		throw new AgentNotWebhookError({ name: opts.name });
	}
}
