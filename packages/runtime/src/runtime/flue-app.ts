/** Public Hono sub-app exposing Flue's built-in agent routes. */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import {
	RouteNotFoundError,
	toHttpResponse,
	validateAgentRequest,
	validateAgentRunRequest,
} from '../errors.ts';
import {
	type AgentHandler,
	type CreateContextFn,
	handleAgentRequest,
	type RunHandlerFn,
	type StartWebhookFn,
} from './handle-agent.ts';
import { type HandleRunRouteOptions, handleRunRouteRequest } from './handle-run-routes.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

/**
 * Runtime configuration for {@link flue}, seeded by the generated server
 * entry before the user's `app.ts` is imported. The shape is internal —
 * users never construct this directly.
 *
 * The Node/Cloudflare branches use different fields. Splitting via a
 * discriminated union would type-check more cleanly, but since the only
 * caller of `configureFlueRuntime` is the build's own generated code,
 * a flat optional-fields shape is simpler to maintain.
 */
export interface FlueRuntime {
	target: 'node' | 'cloudflare';

	/**
	 * Names of agents reachable over HTTP when not in local mode.
	 * Trigger-less agents are excluded from this list and gate access
	 * via {@link FlueRuntime.allowNonWebhook}.
	 */
	webhookAgents: ReadonlyArray<string>;

	/**
	 * If true, the agent route accepts any registered agent — including
	 * trigger-less ones. Used by the Node target when `FLUE_MODE=local`
	 * (set by `flue run` and `flue dev --target node`). Always false on
	 * Cloudflare today.
	 */
	allowNonWebhook: boolean;

	// ─── Node-only ──────────────────────────────────────────────────────────

	/**
	 * Map of agent name → handler function. Includes ALL agents (webhook
	 * and trigger-less); {@link webhookAgents} gates HTTP exposure when
	 * not in local mode. Required when {@link target} is `'node'`.
	 */
	handlers?: Record<string, AgentHandler>;

	/**
	 * Per-target context factory. Required when {@link target} is `'node'`.
	 */
	createContext?: CreateContextFn;

	/** Optional Node webhook execution wrapper. Defaults to direct invocation. */
	startWebhook?: StartWebhookFn;

	/** Optional Node foreground handler wrapper. Defaults to direct invocation. */
	runHandler?: RunHandlerFn;

	/** Node run history store. */
	runStore?: RunStore;

	/** Node in-process registry used for live run-stream tailing. */
	runSubscribers?: RunSubscriberRegistry;

	// ─── Cloudflare-only ────────────────────────────────────────────────────

	/**
	 * Forward an incoming request to the per-agent Durable Object via
	 * Cloudflare's Agents SDK. Required when {@link target} is `'cloudflare'`.
	 *
	 * Returning `null` means "no DO matched" — the caller renders a
	 * `RouteNotFoundError` envelope so the response shape stays
	 * consistent with every other miss.
	 */
	routeAgentRequest?: (
		request: Request,
		env: unknown,
	) => Promise<Response | null>;
}

const RUN_ROUTES: ReadonlyArray<readonly [string, HandleRunRouteOptions['action']]> = [
	['/agents/:name/:id/runs/:runId', 'get'],
	['/agents/:name/:id/runs/:runId/events', 'events'],
	['/agents/:name/:id/runs/:runId/stream', 'stream'],
];

/** Module-scoped runtime config seeded by the generated server entry. */
let runtimeConfig: FlueRuntime | undefined;

/**
 * Seed the runtime config consumed by {@link flue}. Called exactly
 * once at module load by the generated server entry. The Hono routes
 * returned by `flue()` read this config lazily — see the comment on
 * {@link runtimeConfig} for why timing relative to user `app.ts`
 * evaluation is fine.
 *
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
export function configureFlueRuntime(cfg: FlueRuntime): void {
	runtimeConfig = cfg;
}

/**
 * Public Hono sub-app mounting Flue's built-in agent route. Users
 * compose this into their own Hono via Hono's `app.route(path, subApp)`:
 *
 *     import { Hono } from 'hono';
 *     import { flue } from '@flue/runtime/app';
 *
 *     const app = new Hono();
 *     app.use('*', logger());
 *     app.get('/api/ping', (c) => c.json({ pong: true }));
 *     app.route('/', flue());
 *
 *     export default app;
 *
 * Each call to `flue()` returns a fresh Hono. Mounting it twice is
 * legal but pointless — both sub-apps read from the same seeded
 * runtime and produce identical responses.
 *
 * Importable from `@flue/runtime/app`.
 */
export function flue(): Hono {
	const app = new Hono();

	// `app.all` covers any method on the agent route so non-POSTs
	// surface as a canonical 405 (instead of Hono's default 404 for
	// unmatched methods). The `validateAgentRequest` call below is
	// what produces the actual 405 / 404 / 400 envelopes; this just
	// makes sure those paths get reached.
	app.all('/agents/:name/:id', agentRouteHandler);
	for (const [routePath, action] of RUN_ROUTES) {
		app.all(routePath, runRouteHandler(action));
	}

	// Sub-app's `onError` catches throws from `agentRouteHandler` and
	// renders the canonical Flue envelope. Because Hono mounts treat
	// the sub-app's `onError` as the inner handler, the user's outer
	// app.onError(...) only fires for errors thrown in their own
	// routes — Flue errors stay shaped consistently regardless of how
	// the user composed their app. Intentionally NO `notFound`
	// handler: unmatched paths fall through to the outer app, so
	// users keep control of 404s for non-Flue routes.
	app.onError((err) => toHttpResponse(err));

	return app;
}

/**
 * Build the default outer Hono app used when no user `app.ts` is
 * present. Mounts `flue()` at root, renders canonical Flue envelopes
 * for unmatched paths and any thrown errors.
 *
 * Lives in @flue/runtime rather than the generated entry so that user
 * projects on the Cloudflare target — whose `node_modules` does not
 * declare `hono` directly — don't have to add it themselves just to
 * keep the no-`app.ts` default behavior working. When a user does
 * write an `app.ts`, they own this composition and must `pnpm add
 * hono` (or equivalent) themselves.
 */
export function createDefaultFlueApp(): Hono {
	const app = new Hono();
	app.route('/', flue());
	app.notFound((c) => {
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	});
	app.onError((err) => toHttpResponse(err));
	return app;
}

const agentRouteHandler: MiddlewareHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) {
		// `flue()` only works inside a generated server entry.
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}

	// Hono's path param accessor is typed `string | undefined` because
	// it's generic over arbitrary route patterns. For `/agents/:name/:id`
	// both segments are always present at this point — Hono wouldn't
	// have dispatched to this handler otherwise. The empty-string fallback
	// keeps the call types tight and makes the (unreachable in practice)
	// missing-param case fall into `validateAgentRequest`'s empty-segment
	// rejection path so the response stays canonical.
	const name = c.req.param('name') ?? '';
	const id = c.req.param('id') ?? '';

	validateAgentRequest({
		method: c.req.method,
		name,
		id,
		registeredAgents: registeredAgentsFor(rt),
		webhookAgents: rt.webhookAgents,
		allowNonWebhook: rt.allowNonWebhook,
	});

	if (rt.target === 'node') {
		// `validateAgentRequest` above guarantees `name` is in the
		// registered set, which on Node === Object.keys(handlers).
		const handler = rt.handlers![name]!;
		return handleAgentRequest({
			request: c.req.raw,
			agentName: name,
			id,
			handler,
			createContext: rt.createContext!,
			startWebhook: rt.startWebhook,
			runHandler: rt.runHandler,
			runStore: rt.runStore,
			runSubscribers: rt.runSubscribers,
		});
	}

	// Cloudflare: hand off to the per-agent Durable Object via
	// Cloudflare's Agents SDK / partyserver. The DO's `onRequest`
	// then runs `handleAgentRequest` itself with CF-specific
	// keepalive / fiber wrappers. Hono's CF adapter populates
	// `c.env` with the worker bindings, which is exactly what
	// `routeAgentRequest` expects.
	const response = await rt.routeAgentRequest!(c.req.raw, c.env);
	if (response) return response;

	// `routeAgentRequest` returning null means no DO matched the
	// request shape — fall through to a canonical 404 so the
	// envelope stays consistent with the rest of the API.
	throw new RouteNotFoundError({
		method: c.req.method,
		path: new URL(c.req.url).pathname,
	});
};

function runRouteHandler(action: HandleRunRouteOptions['action']): MiddlewareHandler {
	return async (c) => {
		const rt = runtimeConfig;
		if (!rt) {
			throw new Error(
				'[flue] flue() route invoked before runtime was configured. ' +
					'This usually means flue() was used outside a Flue-built server entry.',
			);
		}

		const name = c.req.param('name') ?? '';
		const id = c.req.param('id') ?? '';
		const runId = c.req.param('runId') || undefined;

		validateAgentRunRequest({
			method: c.req.method,
			name,
			id,
			registeredAgents: registeredAgentsFor(rt),
			webhookAgents: rt.webhookAgents,
			allowNonWebhook: rt.allowNonWebhook,
		});

		if (rt.target === 'node') {
			return handleRunRouteRequest({
				request: c.req.raw,
				runStore: rt.runStore,
				runSubscribers: rt.runSubscribers,
				agentName: name,
				id,
				runId,
				action,
			});
		}

		const response = await rt.routeAgentRequest!(c.req.raw, c.env);
		if (response) return response;

		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	};
}

/**
 * Compute the set of agent names considered "registered" for purposes
 * of the agent route's name-validity check.
 *
 *   - Node: every entry in the handler map (including trigger-less
 *     agents — `allowNonWebhook` controls whether they're actually
 *     reachable).
 *   - Cloudflare: only webhook agents have generated DO classes, so
 *     non-webhook names have no valid landing target.
 */
function registeredAgentsFor(rt: FlueRuntime): readonly string[] {
	if (rt.target === 'node') return Object.keys(rt.handlers ?? {});
	return rt.webhookAgents;
}
