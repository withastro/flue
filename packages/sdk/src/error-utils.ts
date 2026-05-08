/**
 * Error framework for Flue.
 *
 * This file holds the abstract scaffolding (renderers, helpers, request-
 * parsing utilities, type guard, logger) that supports the concrete error
 * subclasses defined in `errors.ts`. The two-file split is deliberate:
 *
 *   - `errors.ts` is the *vocabulary*: the `FlueError` base class plus every
 *     concrete subclass Flue can throw. That's the file new contributors
 *     touch when they need to add a new error.
 *
 *   - `error-utils.ts` (this file) is the *framework*: the renderers that
 *     turn errors into HTTP responses and SSE event data, the type guard,
 *     the logger, and the request-parsing utilities. This file rarely
 *     changes.
 *
 * Application code should NOT instantiate `FlueError` directly. Always reach
 * for a subclass from `errors.ts`. If no existing subclass fits, add one
 * there. This is what keeps message tone, detail level, and field naming
 * consistent across the codebase.
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
 *     See `errors.ts` for the two-audience rationale.
 *   - `meta` is included on the wire only when an error subclass sets it
 *     (rare).
 *   - `cause` is never included on the wire (it's logged server-side only).
 */

import {
	AgentNotFoundError,
	AgentNotWebhookError,
	FlueError,
	FlueHttpError,
	InvalidJsonError,
	InvalidRequestError,
	MethodNotAllowedError,
	UnsupportedMediaTypeError,
} from './errors.ts';

// ─── Type guard ─────────────────────────────────────────────────────────────

export function isFlueError(value: unknown): value is FlueError {
	return value instanceof FlueError;
}

// ─── Logging ────────────────────────────────────────────────────────────────

/**
 * Structured error logger. Used by the HTTP and SSE renderers below to log
 * unknown/wrapped errors before rendering a generic envelope.
 *
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
		// `console.error` already conveys severity; no need to repeat it in
		// the prefix. The bracketed type tag (e.g. `[agent_not_found]`)
		// remains in the formatted line.
		console.error(formatForLog('[flue]', err));
	},
};

// ─── Wire envelope ──────────────────────────────────────────────────────────

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
 * `dev` field is included on the wire — see the convention doc in `errors.ts`.
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

// ─── Renderers ──────────────────────────────────────────────────────────────

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

// ─── Request-parsing helpers ────────────────────────────────────────────────
//
// These are HTTP-layer helpers that throw the concrete subclasses defined in
// `errors.ts`. They live here (rather than there) because they're framework
// utilities, not error definitions; `errors.ts` stays focused on the error
// vocabulary.

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
