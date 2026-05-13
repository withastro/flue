/** Public Hono sub-app exposing Flue's built-in agent routes. */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import {
	describeRoute,
	openAPIRouteHandler,
	resolver,
	type DescribeRouteOptions,
	validator,
} from 'hono-openapi';
import {
	RouteNotFoundError,
	RunNotFoundError,
	RunRegistryUnavailableError,
	toHttpResponse,
	validateAgentRequest,
	ValidationError,
} from '../errors.ts';
import {
	type AgentHandler,
	type CreateContextFn,
	handleAgentRequest,
	type RunHandlerFn,
	type StartWebhookFn,
} from './handle-agent.ts';
import { type HandleRunRouteOptions, handleRunRouteRequest } from './handle-run-routes.ts';
import type { RunRegistry } from './run-registry.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';
import {
	AgentInvocationResponseSchema,
	AgentRouteParamSchema,
	ErrorEnvelopeSchema,
	RunEventListResponseSchema,
	RunEventsQuerySchema,
	RunIdParamSchema,
	RunRecordSchema,
	WebhookInvocationResponseSchema,
} from './schemas.ts';

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

	/**
	 * Cross-deployment run pointer index used to resolve bare
	 * `/runs/:runId` lookups. On Node the value is a module-scoped
	 * `InMemoryRunRegistry`; on Cloudflare it's populated per-request
	 * from a `FlueRegistry` Durable Object client (Commit B). Optional
	 * by the same convention as {@link runStore}: routes that strictly
	 * require it throw a structured `*Unavailable` envelope when it's
	 * unset.
	 */
	runRegistry?: RunRegistry;

	// ─── Cloudflare-only ────────────────────────────────────────────────────

	/**
	 * Forward an incoming request to the per-agent Durable Object via
	 * Cloudflare's Agents SDK. Required when {@link target} is `'cloudflare'`.
	 *
	 * Returning `null` means "no DO matched" — the caller renders a
	 * `RouteNotFoundError` envelope so the response shape stays
	 * consistent with every other miss.
	 */
	routeAgentRequest?: (request: Request, env: unknown) => Promise<Response | null>;

	/**
	 * Forward an incoming bare `/runs/:runId` request to the agent DO
	 * that owns the run, identified by the registry-resolved pointer.
	 *
	 * Cloudflare-only. The main worker first calls
	 * `runRegistry.lookupRun(runId)` to discover `(agentName, instanceId)`,
	 * then hands those off to this seam to do the actual DO dispatch.
	 * The DO accepts the bare `/runs/:runId` URL shape directly (per
	 * Phase 1 decision 8) so the original request URL is forwarded
	 * unchanged.
	 */
	routeRunRequest?: (
		request: Request,
		env: unknown,
		target: { agentName: string; instanceId: string },
	) => Promise<Response | null>;

	/**
	 * Per-request `RunRegistry` factory. On Cloudflare the registry's
	 * binding (`env.FLUE_REGISTRY`) is only available inside a request
	 * scope, so the runtime config supplies a factory rather than a
	 * pre-bound registry. The bare-`/runs/:runId` route handler calls
	 * this once per request to obtain a client, then issues the
	 * `lookupRun` against it. The same factory feeds {@link runRegistry}
	 * on Cloudflare so the `recordRunStart` / `recordRunEnd` writes
	 * inside `handleAgentRequest` reach the same DO.
	 *
	 * Returns `undefined` when the `env.FLUE_REGISTRY` binding is
	 * missing (most likely an older deployment whose `dist/wrangler.jsonc`
	 * predates this Flue version's build). The route handler renders a
	 * canonical `RunRegistryUnavailableError` envelope (501) in that
	 * case, symmetric with the Node target's behavior when `runRegistry`
	 * is unset.
	 */
	createRunRegistryForRequest?: (env: unknown) => RunRegistry | undefined;

	/** Package version inlined by the generated entry for OpenAPI metadata. */
	runtimeVersion?: string;
}

/**
 * Bare run-lookup routes. Identified by `runId` alone — the owning
 * `(agentName, instanceId)` is resolved at request time via the
 * runtime's {@link RunRegistry}. Prior to Phase 1 / Commit C these
 * routes also existed in a prefixed form
 * (`/agents/<name>/<id>/runs/<runId>{,/events,/stream}`) that has
 * since been removed; the registry's reverse-lookup is the entire
 * point of dropping it.
 */
const RUN_ROUTES_BY_ID: ReadonlyArray<readonly [string, HandleRunRouteOptions['action']]> = [
	['/runs/:runId', 'get'],
	['/runs/:runId/events', 'events'],
	['/runs/:runId/stream', 'stream'],
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

	app.get('/openapi.json', openAPIRouteHandler(app, publicOpenApiOptions()));

	app.post(
		'/agents/:name/:id',
		describeRoute(agentRouteSpec() as DescribeRouteOptions),
		validated('param', AgentRouteParamSchema),
		agentRouteHandler,
	);
	// Non-POSTs still reach the canonical Flue 405 envelope instead of
	// Hono's default 404 for unmatched methods.
	app.all('/agents/:name/:id', agentRouteHandler);
	for (const [routePath, action] of RUN_ROUTES_BY_ID) {
		if (action === 'events') {
			app.get(
				routePath,
				describeRoute(runRouteSpec(action) as DescribeRouteOptions),
				validated('param', RunIdParamSchema),
				validated('query', RunEventsQuerySchema),
				runByIdRouteHandler(action),
			);
		} else {
			app.get(
				routePath,
				describeRoute(runRouteSpec(action) as DescribeRouteOptions),
				validated('param', RunIdParamSchema),
				runByIdRouteHandler(action),
			);
		}
		app.all(routePath, runByIdRouteHandler(action));
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

function publicOpenApiOptions() {
	return {
		documentation: {
			info: {
				title: 'Flue Public API',
				version: runtimeConfig?.runtimeVersion ?? '0.0.0',
				description: 'Public Flue agent invocation and run inspection API.',
			},
			servers: [],
		},
	};
}

function validated(
	target: 'param' | 'query',
	schema: Parameters<typeof validator>[1],
): MiddlewareHandler {
	return validator(target, schema, (result) => {
		if (result.success) return;
		throw new ValidationError({
			details: `Invalid ${target} parameters.`,
			issues: result.error,
		});
	}) as MiddlewareHandler;
}

function jsonResponse(schema: Parameters<typeof resolver>[0], description: string) {
	return {
		description,
		content: {
			'application/json': {
				schema: resolver(schema),
			},
		},
	};
}

function errorResponses() {
	return {
		400: jsonResponse(ErrorEnvelopeSchema, 'Validation or request-shape error.'),
		404: jsonResponse(ErrorEnvelopeSchema, 'Resource or route not found.'),
		405: jsonResponse(ErrorEnvelopeSchema, 'HTTP method is not allowed.'),
		415: jsonResponse(ErrorEnvelopeSchema, 'Request body must be JSON.'),
		500: jsonResponse(ErrorEnvelopeSchema, 'Internal server error.'),
		501: jsonResponse(ErrorEnvelopeSchema, 'Runtime feature is not configured.'),
	};
}

function agentRouteSpec() {
	return {
		tags: ['agents'],
		operationId: 'invokeAgent',
		summary: 'Invoke an agent instance',
		description:
			'Invokes the named agent instance. The request body is user-defined by the target agent.',
		requestBody: {
			required: false,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						additionalProperties: true,
						description: 'Agent-defined payload. Consult the target agent documentation.',
					},
				},
			},
		},
		responses: {
			200: jsonResponse(AgentInvocationResponseSchema, 'Synchronous invocation result.'),
			202: jsonResponse(WebhookInvocationResponseSchema, 'Webhook invocation accepted.'),
			...errorResponses(),
		},
		'x-flue-invocation-modes': ['sync', 'webhook', 'stream'],
		'x-flue-user-defined': true,
	};
}

function runRouteSpec(action: HandleRunRouteOptions['action']) {
	if (action === 'stream') {
		return {
			tags: ['runs'],
			operationId: 'streamRunEvents',
			summary: 'Stream run events',
			responses: {
				200: {
					description: 'Server-sent events stream of run lifecycle and agent events.',
					content: {
						'text/event-stream': {
							schema: {
								type: 'string',
								description: 'SSE-framed FlueEvent values.',
							},
						},
					},
				},
				...errorResponses(),
			},
			'x-flue-streaming': true,
		};
	}
	return {
		tags: ['runs'],
		operationId: action === 'get' ? 'getRun' : 'listRunEvents',
		summary: action === 'get' ? 'Get a run record' : 'List run events',
		responses: {
			200: jsonResponse(
				action === 'get' ? RunRecordSchema : RunEventListResponseSchema,
				action === 'get' ? 'Run record.' : 'Persisted run event page.',
			),
			...errorResponses(),
		},
	};
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
			runRegistry: rt.runRegistry,
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

/**
 * Bare `/runs/:runId` route handler. Resolves the run's owning agent +
 * instance via the runtime's {@link RunRegistry}, then delegates to
 * `handleRunRouteRequest` with the registry-supplied identifiers.
 *
 * Lookup-and-forward shape rather than direct store access so the Node
 * and Cloudflare implementations share one route handler. On Node the
 * registry pointer maps to the module-scoped `runStore` directly; on
 * Cloudflare the lookup is followed by a DO dispatch to the owning
 * agent DO via `routeRunRequest`, which owns the run's record + events
 * + live stream.
 */
function runByIdRouteHandler(action: HandleRunRouteOptions['action']): MiddlewareHandler {
	return async (c) => {
		const rt = runtimeConfig;
		if (!rt) {
			throw new Error(
				'[flue] flue() route invoked before runtime was configured. ' +
					'This usually means flue() was used outside a Flue-built server entry.',
			);
		}

		// Method check first so a POST/PUT/DELETE to /runs/:runId surfaces
		// a canonical envelope, not Hono's default plain 404. We can't
		// reuse the agent-route validator here — it validates agent
		// name/id, which we don't have until after the registry lookup.
		if (c.req.method !== 'GET') {
			throw new RouteNotFoundError({
				method: c.req.method,
				path: new URL(c.req.url).pathname,
			});
		}

		const runId = c.req.param('runId') || undefined;
		if (!runId) {
			throw new RouteNotFoundError({
				method: c.req.method,
				path: new URL(c.req.url).pathname,
			});
		}

		if (rt.target === 'cloudflare') {
			// CF flow: construct a per-request registry client from the
			// `FLUE_REGISTRY` binding, resolve the run pointer, then forward
			// to the owning agent DO via the `routeRunRequest` seam. The DO
			// itself accepts the bare `/runs/:runId` URL shape (decision 8),
			// so we hand the original request through unchanged.
			if (!rt.createRunRegistryForRequest || !rt.routeRunRequest) {
				throw new RunRegistryUnavailableError();
			}
			const registry = rt.createRunRegistryForRequest(c.env);
			// The factory returns `undefined` when the env.FLUE_REGISTRY
			// binding is absent (older deployment, broken local config).
			// Surface the canonical 501 envelope rather than letting a
			// downstream stub throw an unstructured Error that the outer
			// onError would render as a generic 500. Symmetric with the
			// Node target's `!rt.runRegistry` check below.
			if (!registry) throw new RunRegistryUnavailableError();
			const pointer = await registry.lookupRun(runId);
			if (!pointer) throw new RunNotFoundError({ runId });

			const response = await rt.routeRunRequest(c.req.raw, c.env, {
				agentName: pointer.agentName,
				instanceId: pointer.instanceId,
			});
			if (response) return response;
			throw new RouteNotFoundError({
				method: c.req.method,
				path: new URL(c.req.url).pathname,
			});
		}

		// Node flow: registry + stores are all module-scoped, so the
		// lookup is direct and the existing run-routes handler can read
		// from the in-memory store with the registry-supplied identifiers.
		if (!rt.runRegistry) throw new RunRegistryUnavailableError();
		const pointer = await rt.runRegistry.lookupRun(runId);
		if (!pointer) throw new RunNotFoundError({ runId });

		return handleRunRouteRequest({
			request: c.req.raw,
			runStore: rt.runStore,
			runSubscribers: rt.runSubscribers,
			agentName: pointer.agentName,
			id: pointer.instanceId,
			runId,
			action,
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
