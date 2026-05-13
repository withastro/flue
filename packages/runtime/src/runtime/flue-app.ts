import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import {
	type DescribeRouteOptions,
	describeRoute,
	openAPIRouteHandler,
	resolver,
	validator,
} from 'hono-openapi';
import {
	MethodNotAllowedError,
	RouteNotFoundError,
	RunNotFoundError,
	RunRegistryUnavailableError,
	toHttpResponse,
	ValidationError,
	validateAgentRequest,
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

	/** Cross-deployment run pointer index for bare `/runs/:runId` lookups. */
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

	/** Cloudflare-only forwarding hook for registry-resolved run requests. */
	routeRunRequest?: (
		request: Request,
		env: unknown,
		target: { agentName: string; instanceId: string },
	) => Promise<Response | null>;

	/** Cloudflare-only factory for the request-scoped registry client. */
	createRunRegistryForRequest?: (env: unknown) => RunRegistry | undefined;

	/** Package version inlined by the generated entry for OpenAPI metadata. */
	runtimeVersion?: string;

	/** Build manifest inlined by the generated entry for admin listing routes. */
	manifest?: FlueManifest;
}

export interface FlueManifest {
	agents: Array<{ name: string; triggers: { webhook?: boolean } }>;
}

const RUN_ROUTES_BY_ID: ReadonlyArray<readonly [string, HandleRunRouteOptions['action']]> = [
	['/runs/:runId', 'get'],
	['/runs/:runId/events', 'events'],
	['/runs/:runId/stream', 'stream'],
];

let runtimeConfig: FlueRuntime | undefined;

/**
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
export function configureFlueRuntime(cfg: FlueRuntime): void {
	runtimeConfig = cfg;
}

export function getFlueRuntime(): FlueRuntime | undefined {
	return runtimeConfig;
}

/**
 * Importable from `@flue/runtime/app`.
 */
export function flue(): Hono {
	const app = new Hono();

	app.get('/openapi.json', lazyOpenApiRouteHandler(app, publicOpenApiOptions));

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
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}

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
		const handler = rt.handlers?.[name];
		const createContext = rt.createContext;
		if (!handler || !createContext) {
			throw new Error('[flue] Node runtime is missing agent handler configuration.');
		}
		return handleAgentRequest({
			request: c.req.raw,
			agentName: name,
			id,
			handler,
			createContext,
			startWebhook: rt.startWebhook,
			runHandler: rt.runHandler,
			runStore: rt.runStore,
			runSubscribers: rt.runSubscribers,
			runRegistry: rt.runRegistry,
		});
	}

	if (!rt.routeAgentRequest) {
		throw new Error('[flue] Cloudflare runtime is missing agent route forwarding.');
	}
	const response = await rt.routeAgentRequest(c.req.raw, c.env);
	if (response) return response;

	throw new RouteNotFoundError({
		method: c.req.method,
		path: new URL(c.req.url).pathname,
	});
};

export function runByIdRouteHandler(action: HandleRunRouteOptions['action']): MiddlewareHandler {
	return async (c) => {
		const rt = runtimeConfig;
		if (!rt) {
			throw new Error(
				'[flue] flue() route invoked before runtime was configured. ' +
					'This usually means flue() was used outside a Flue-built server entry.',
			);
		}

		if (c.req.method !== 'GET') {
			throw new MethodNotAllowedError({ method: c.req.method, allowed: ['GET'] });
		}

		const runId = c.req.param('runId') || undefined;
		if (!runId) {
			throw new RouteNotFoundError({
				method: c.req.method,
				path: new URL(c.req.url).pathname,
			});
		}

		return handleRunById({
			rt,
			request: c.req.raw,
			env: c.env,
			runId,
			action,
		});
	};
}

export async function handleRunById(opts: {
	rt: FlueRuntime;
	request: Request;
	env: unknown;
	runId: string;
	action: HandleRunRouteOptions['action'];
}): Promise<Response> {
	const { rt, request, env, runId, action } = opts;
	if (rt.target === 'cloudflare') {
		if (!rt.createRunRegistryForRequest || !rt.routeRunRequest) {
			throw new RunRegistryUnavailableError();
		}
		const registry = rt.createRunRegistryForRequest(env);
		if (!registry) throw new RunRegistryUnavailableError();
		const pointer = await registry.lookupRun(runId);
		if (!pointer) throw new RunNotFoundError({ runId });

		const response = await rt.routeRunRequest(normalizeRunRequest(request, runId, action), env, {
			agentName: pointer.agentName,
			instanceId: pointer.instanceId,
		});
		if (response) return response;
		throw new RouteNotFoundError({
			method: request.method,
			path: new URL(request.url).pathname,
		});
	}

	if (!rt.runRegistry) throw new RunRegistryUnavailableError();
	const pointer = await rt.runRegistry.lookupRun(runId);
	if (!pointer) throw new RunNotFoundError({ runId });

	return handleRunRouteRequest({
		request,
		runStore: rt.runStore,
		runSubscribers: rt.runSubscribers,
		agentName: pointer.agentName,
		id: pointer.instanceId,
		runId,
		action,
	});
}

function lazyOpenApiRouteHandler(app: Hono, getOptions: () => ReturnType<typeof publicOpenApiOptions>): MiddlewareHandler {
	return (c, next) => openAPIRouteHandler(app, getOptions())(c, next);
}

function normalizeRunRequest(
	request: Request,
	runId: string,
	action: HandleRunRouteOptions['action'],
): Request {
	const url = new URL(request.url);
	url.pathname =
		action === 'events'
			? `/runs/${encodeURIComponent(runId)}/events`
			: action === 'stream'
				? `/runs/${encodeURIComponent(runId)}/stream`
				: `/runs/${encodeURIComponent(runId)}`;
	return new Request(url, request);
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
