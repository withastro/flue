/**
 * Concrete error classes thrown by Flue.
 *
 * This file is the *vocabulary* of errors in Flue. Every error the framework
 * throws has a class here. The framework scaffolding (base class, renderers,
 * type guards, request-parsing helpers) lives in `error-utils.ts`.
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
 *     //            loaded from the workspace's "agents/" directory at
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
			// Dev-only: sibling enumeration and workspace mechanics. Useful
			// for the human running the service; would leak namespace state
			// or framework details to a public caller.
			dev:
				`Available agents: ${formatList(available)}.\n` +
				`Agents are loaded from the workspace's "agents/" directory at build time. ` +
				`Verify the agent file is present in the workspace being served.`,
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
