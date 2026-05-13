/**
 * Sentry error reporting for Flue.
 *
 * This file is the entire integration. It does two things:
 *
 *   1. Initializes the Sentry Node SDK at module scope so every isolate
 *      that imports `app.ts` has a configured Sentry client.
 *
 *   2. Calls `observe(...)` to register a global Flue event subscriber
 *      that translates run-fatal errors and explicit error logs into
 *      `Sentry.captureException(...)` calls with Flue correlation tags.
 *
 * Read top-to-bottom — there are no other Sentry-related files in the
 * project. Every agent in `.flue/agents/` is a plain Flue handler;
 * none of them know that Sentry exists.
 *
 *
 * Scope of this example
 * ─────────────────────
 *
 * This is intentionally focused on **error reporting**:
 *
 *   - run-fatal errors (the handler throws / rejects) → captured as
 *     Sentry exceptions at `error` level.
 *   - `ctx.log.error(...)` calls from handlers → captured as Sentry
 *     exceptions when an `error` attribute is present, otherwise as
 *     messages at `error` level.
 *
 * What this example does NOT do (deliberate, for now):
 *
 *   - It does not emit Sentry spans / traces for runs, operations, or
 *     tool calls. The Flue event stream already carries the data a
 *     future span-based integration would need (`durationMs`, `usage`,
 *     `operationKind`, etc.), so layering spans on top is a follow-up
 *     rather than a redesign.
 *   - It does not forward `ctx.log.info` / `.warn` to Sentry breadcrumbs
 *     or logs. Add `Sentry.addBreadcrumb({ ... })` inside the `observe`
 *     callback if you want that — it's a five-line change.
 *   - It does not capture per-operation or per-tool failures. Those are
 *     usually recoverable (the model handles tool errors and keeps
 *     going), so capturing them tends to be noise. If you want them,
 *     uncomment the `operation` / `tool_call` branches inside the
 *     `observe(...)` callback below.
 *
 *
 * Isolate scoping (read this once, then forget about it)
 * ──────────────────────────────────────────────────────
 *
 * On the Node target the entire server runs in one V8 isolate, so
 * "global" subscribers are truly global.
 *
 * On the Cloudflare target each agent runs in its own Durable Object,
 * which is its own V8 isolate. This file (`app.ts`) is evaluated once
 * per isolate — the outer Worker once, plus each DO once. That means
 * `Sentry.init` and `observe(...)` run independently inside every DO.
 * Each isolate captures its own errors with its own Sentry client.
 * No cross-isolate plumbing is needed (and none is possible without
 * RPC). This is the right shape, not a workaround.
 *
 *
 * Environment variables
 * ─────────────────────
 *
 *   SENTRY_DSN          required to send anything. If unset, the SDK
 *                       is initialized in "disabled" mode and your app
 *                       runs unchanged.
 *   SENTRY_ENVIRONMENT  e.g. "production", "staging". Defaults to
 *                       NODE_ENV.
 *   SENTRY_RELEASE      e.g. a git SHA. Optional.
 */

import { flue, observe } from '@flue/runtime/app';
import type { FlueContext, FlueEvent } from '@flue/runtime';
import * as Sentry from '@sentry/node';
import { Hono } from 'hono';

// ─── 1. Sentry init ─────────────────────────────────────────────────────────

// `Sentry.init` is module-scoped: it runs once per isolate, before any
// HTTP request is served. When SENTRY_DSN is unset (e.g. in local
// development without a DSN handy), `enabled: false` makes every
// capture call a no-op. The rest of this file behaves the same either
// way, so you don't have to gate it.
//
// `tracesSampleRate: 0` is explicit: this example does not produce
// spans, so we disable Sentry's tracing engine entirely. Set this to
// a positive number only if you add span-emitting code yourself.
Sentry.init({
	dsn: process.env.SENTRY_DSN,
	environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
	release: process.env.SENTRY_RELEASE,
	tracesSampleRate: 0,
	enabled: Boolean(process.env.SENTRY_DSN),
});

// ─── 2. The Flue → Sentry event bridge ──────────────────────────────────────

// `observe` is the only Flue API this file uses besides `flue()`
// itself. It is module-scoped on purpose: register once, fire for
// every run handled by this isolate, for the lifetime of the
// isolate. There is no per-agent wiring and no per-request
// registration.
//
// The callback runs synchronously inside the Flue event emit path,
// so it must be cheap and must not throw. (Sentry's `withScope` and
// `captureException` are both synchronous JS calls that queue work
// internally; they will not block the run.)
observe((event, ctx) => {
	// Common Flue correlation tags — attached to every Sentry
	// capture made from this bridge so an investigator can pivot
	// from a Sentry issue to a Flue run via:
	//
	//   GET /agents/<flue.agent>/<flue.instance_id>/runs/<flue.run_id>
	//
	// or replay the run via the CLI:
	//
	//   flue logs <flue.agent> <flue.instance_id> <flue.run_id>
	const tags = flueCorrelationTags(event, ctx);

	// ─── Run-fatal: the handler threw or rejected ─────────────────────
	//
	// `run_end` fires exactly once per run. When `isError` is true,
	// the handler did not return successfully — this is the
	// canonical "something broke" signal.
	if (event.type === 'run_end' && event.isError) {
		Sentry.withScope((scope) => {
			scope.setTags(tags);
			scope.setLevel('error');
			scope.setContext('flue.run', {
				durationMs: event.durationMs,
				agentName: tags['flue.agent'],
				instanceId: ctx.id,
			});
			Sentry.captureException(reconstructError(event.error));
		});
		return;
	}

	// ─── Explicit handler-side error logs ─────────────────────────────
	//
	// `ctx.log.error(message, { error })` is how handler code says
	// "I want this in my error reporter without crashing the run."
	// We mirror Junior's convention: if the log carries an `error`
	// attribute, capture it as an exception; otherwise capture the
	// message itself at `error` level.
	if (event.type === 'log' && event.level === 'error') {
		Sentry.withScope((scope) => {
			scope.setTags(tags);
			scope.setLevel('error');
			if (event.attributes) {
				scope.setContext('flue.log_attributes', event.attributes);
			}
			const errorAttr = event.attributes?.error;
			if (errorAttr) {
				Sentry.captureException(reconstructError(errorAttr));
			} else {
				Sentry.captureMessage(event.message, 'error');
			}
		});
		return;
	}

	// ─── Not captured (and why) ───────────────────────────────────────
	//
	// `operation` events with `isError: true` represent a single
	// `prompt()` / `skill()` / `task()` / `shell()` call that
	// threw. If the agent handler caught and recovered, the run is
	// still healthy — capturing here would be noise. If the
	// handler did NOT catch, the same error propagates up to
	// `run_end` above and is captured there.
	//
	// `tool_call` events with `isError: true` represent a tool body
	// that threw or returned an error. The model usually keeps
	// going with the error result and recovers. Capturing every
	// tool error would drown out real incidents. Add a branch here
	// if your agents do something where tool failures are
	// catastrophic.
	//
	// Uncomment to enable:
	//
	//   if (event.type === 'operation' && event.isError) { ... }
	//   if (event.type === 'tool_call' && event.isError) { ... }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the Sentry tags attached to every capture from this bridge.
 *
 * Tag keys use the `flue.*` prefix to namespace them away from
 * Sentry's built-in tags and from any application tags the user
 * adds. Pivoting on `flue.run_id` in Sentry's search box is the
 * fastest way to find every issue raised by a single Flue run.
 */
function flueCorrelationTags(
	event: FlueEvent,
	ctx: FlueContext,
): Record<string, string> {
	const tags: Record<string, string> = {
		'flue.instance_id': ctx.id,
	};
	if (event.runId) tags['flue.run_id'] = event.runId;
	if (event.harness) tags['flue.harness'] = event.harness;
	if (event.session) tags['flue.session'] = event.session;
	if (event.parentSession) tags['flue.parent_session'] = event.parentSession;
	if (event.operationId) tags['flue.operation_id'] = event.operationId;
	if (event.taskId) tags['flue.task_id'] = event.taskId;
	// `run_start` carries the agent name; cache it via the most
	// common shape so other events can pick it up too. (Currently
	// only `run_start` includes `agentName`, but we don't depend on
	// that — we read it defensively.)
	if (event.type === 'run_start') tags['flue.agent'] = event.agentName;
	return tags;
}

/**
 * Reconstruct an `Error` instance from a value that may already be an
 * `Error`, may be the JSON-serialized envelope Flue's run-store uses
 * (`{ name, message }`), or may be something arbitrary a handler
 * threw (a string, a number, a plain object).
 *
 * Sentry's `captureException` does its best with non-Error values,
 * but it produces much better issue grouping when given a real
 * `Error` with a stable `name` and `message`.
 */
function reconstructError(raw: unknown): Error {
	if (raw instanceof Error) return raw;
	if (raw && typeof raw === 'object') {
		const o = raw as { name?: unknown; message?: unknown; stack?: unknown };
		const message =
			typeof o.message === 'string' ? o.message : safeStringify(raw);
		const err = new Error(message);
		if (typeof o.name === 'string') err.name = o.name;
		if (typeof o.stack === 'string') err.stack = o.stack;
		return err;
	}
	return new Error(typeof raw === 'string' ? raw : safeStringify(raw));
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

// ─── 3. Mount the Flue agent route ──────────────────────────────────────────

const app = new Hono();
app.route('/', flue());

export default app;
