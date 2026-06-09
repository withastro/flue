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
	configureErrorRendering,
	MethodNotAllowedError,
	RouteNotFoundError,
	RunNotFoundError,
	RunRegistryUnavailableError,
	toHttpResponse,
	ValidationError,
	validateAgentRequest,
	validateWorkflowRequest,
} from '../errors.ts';
import type {
	AgentDispatchRequest,
	CreatedAgent,
	DispatchReceipt,
	NamedAgentDispatchRequest,
} from '../types.ts';
import { enqueueDispatch } from './dispatch.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import {
	type CreateContextFn,
	handleAgentRequest,
	handleWorkflowRequest,
	type StartWorkflowAdmissionFn,
	type WorkflowHandler,
} from './handle-agent.ts';
import { type HandleRunRouteOptions, handleRunRouteRequest } from './handle-run-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import type { RunPointer, RunRegistry } from './run-registry.ts';
import type { EventStreamStore } from './event-stream-store.ts';
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
	WorkflowAdmissionResponseSchema,
	WorkflowInvocationQuerySchema,
	WorkflowInvocationResponseSchema,
	WorkflowRouteParamSchema,
} from './schemas.ts';

export interface FlueRuntime {
	target: 'node' | 'cloudflare';
	devMode?: boolean;

	// ─── Node-only ──────────────────────────────────────────────────────────

	workflowHandlers?: Record<string, WorkflowHandler>;
	agentRouteMiddleware?: Record<string, MiddlewareHandler>;
	agentWebSocketMiddleware?: Record<string, MiddlewareHandler>;
	workflowRouteMiddleware?: Record<string, MiddlewareHandler>;
	workflowWebSocketMiddleware?: Record<string, MiddlewareHandler>;
	nodeWebSocketAgentRoute?: MiddlewareHandler;
	nodeWebSocketWorkflowRoute?: MiddlewareHandler;

	/**
	 * Per-target context factory. Required when {@link target} is `'node'`.
	 */
	createContext?: CreateContextFn;

	/** Optional Node HTTP workflow admitted execution wrapper. Defaults to direct invocation. */
	startWorkflowAdmission?: StartWorkflowAdmissionFn;

	/**
	 * Per-agent durable admission factory, keyed by agent name. Direct HTTP,
	 * SSE, and WebSocket prompts are persisted as durable submissions. Each
	 * factory receives the instance ID from the route and returns the admission
	 * hook for that specific agent instance. Created by the Node coordinator's
	 * `createAdmission()`.
	 */
	createAdmission?: Record<string, (instanceId: string) => AttachedAgentSubmissionAdmission>;

	/** Node workflow-run history store. */
	runStore?: RunStore;

	/** Node in-process registry used for live run-stream tailing. */
	runSubscribers?: RunSubscriberRegistry;

	/** Durable event stream store for DS-compatible event persistence. */
	eventStreamStore?: EventStreamStore;

	/** Cross-deployment workflow-run pointer index for bare `/runs/:runId` lookups. */
	runRegistry?: RunRegistry;

	// ─── Cloudflare-only ────────────────────────────────────────────────────

	/** Forward an incoming request to the per-agent Durable Object. Required when {@link target} is `'cloudflare'`. */
	routeAgentRequest?: (
		request: Request,
		env: unknown,
		target: { agentName: string; instanceId: string },
	) => Promise<Response | null>;
	/**
	 * Forward a new workflow run to its per-workflow Durable Object instance.
	 * The `instanceId` is the freshly generated run id — workflows have one
	 * instance per run, so the two values are the same. Required when
	 * {@link target} is `'cloudflare'`.
	 *
	 * Returning `null` means "no DO matched" — the caller renders a
	 * `RouteNotFoundError` envelope so the response shape stays
	 * consistent with every other miss.
	 */
	routeWorkflowRequest?: (
		request: Request,
		env: unknown,
		target: { workflowName: string; instanceId: string },
	) => Promise<Response | null>;

	/** Cloudflare-only forwarding hook for registry-resolved run requests. */
	routeRunRequest?: (
		request: Request,
		env: unknown,
		target: RunPointer['owner'],
	) => Promise<Response | null>;

	/** Cloudflare-only factory for the request-scoped registry client. */
	createRunRegistryForRequest?: (env: unknown) => RunRegistry | undefined;

	/** Package version inlined by the generated entry for OpenAPI metadata. */
	runtimeVersion?: string;

	/** Build manifest inlined by the generated entry for admin listing routes. */
	manifest?: FlueManifest;

	/** Internal dispatch admission queue. Defaults to process-lifetime memory. */
	dispatchQueue?: DispatchQueue;

	/** Resolve discovered/default-exported created agent identities for global dispatch. */
	resolveDispatchAgentName?: (agent: CreatedAgent) => string | undefined;
}

export interface FlueManifest {
	agents: Array<{
		name: string;
		transports: { http?: true; websocket?: true };
		created: boolean;
	}>;
	workflows?: Array<{
		name: string;
		transports: { http?: boolean; websocket?: boolean };
	}>;
}

export type ExposedTransport = 'http' | 'websocket';

const RUN_ROUTES_BY_ID: ReadonlyArray<readonly [string, HandleRunRouteOptions['action']]> = [
	['/runs/:runId', 'get'],
	['/runs/:runId/events', 'events'],
	['/runs/:runId/stream', 'stream'],
];

/**
 * Accepts input for asynchronous delivery to a continuing agent session.
 *
 * Resolves after the current runtime admits and queues the input. It does not
 * wait for model processing, tool calls, or an agent reply. The returned
 * `dispatchId` identifies delivery and is not a workflow `runId`; dispatched
 * input does not create workflow-run history.
 *
 * The created-agent overload requires a value default-exported by exactly one
 * discovered `agents/<name>.ts` module. The named overload targets a discovered
 * agent module by name.
 *
 * Delivery durability depends on the generated target. Node uses a
 * process-lifetime in-memory queue by default. Cloudflare durably admits work
 * to the target agent Durable Object and may retry processing after an
 * interruption. Cloudflare processing can therefore be at-least-once; design
 * external side effects to be idempotent.
 */
export function dispatch(
	agent: CreatedAgent,
	request: AgentDispatchRequest,
): Promise<DispatchReceipt>;
export function dispatch(request: NamedAgentDispatchRequest): Promise<DispatchReceipt>;
export async function dispatch(
	agentOrRequest: CreatedAgent | NamedAgentDispatchRequest,
	maybeRequest?: AgentDispatchRequest,
): Promise<DispatchReceipt> {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] dispatch() called before runtime was configured. ' +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}
	if (!rt.dispatchQueue) {
		throw new Error(
			'[flue] dispatch() cannot be accepted because no dispatch queue is configured.',
		);
	}
	const request = isCreatedAgentValue(agentOrRequest)
		? resolveCreatedAgentDispatchRequest(agentOrRequest, maybeRequest, rt)
		: agentOrRequest;
	return enqueueDispatch({ request, dispatchQueue: rt.dispatchQueue, rt });
}

function isCreatedAgentValue(
	value: CreatedAgent | NamedAgentDispatchRequest,
): value is CreatedAgent {
	return (
		'__flueCreatedAgent' in value &&
		value.__flueCreatedAgent === true &&
		typeof value.initialize === 'function'
	);
}

function resolveCreatedAgentDispatchRequest(
	agent: CreatedAgent,
	request: AgentDispatchRequest | undefined,
	rt: FlueRuntime,
): NamedAgentDispatchRequest {
	if (!request) throw new Error('[flue] dispatch(agent, request) requires a dispatch request.');
	const name = rt.resolveDispatchAgentName?.(agent);
	if (!name) {
		throw new Error(
			'[flue] dispatch() target created agent is not a discovered default-exported agent in this built application.',
		);
	}
	return { agent: name, id: request.id, input: request.input };
}

let runtimeConfig: FlueRuntime | undefined;

/**
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
export function configureFlueRuntime(cfg: FlueRuntime): void {
	runtimeConfig = cfg;
	configureErrorRendering({ devMode: cfg.devMode ?? false });
}

export function resetFlueRuntimeForTests(): void {
	runtimeConfig = undefined;
	configureErrorRendering({ devMode: false });
}

export function getFlueRuntime(): FlueRuntime | undefined {
	return runtimeConfig;
}

/**
 * Creates a mountable Hono sub-app for Flue's public HTTP and WebSocket API.
 * Routes are relative to the application-chosen mount prefix.
 *
 * The mounted sub-app exposes:
 *
 * - `GET /openapi.json`
 * - `POST /agents/:name/:id` and `GET /agents/:name/:id` WebSocket upgrades
 * - `POST /workflows/:name` and `GET /workflows/:name` WebSocket upgrades
 * - `GET /runs/:runId`
 * - `GET /runs/:runId/events`
 * - `GET /runs/:runId/stream`
 *
 * Agent and workflow routes are available only when the corresponding module
 * opts into that transport. Run routes inspect workflow runs only and may
 * expose payloads, results, errors, and events; applications publishing them
 * should authorize access to the selected run.
 */
export function flue(): Hono {
	const app = new Hono();

	app.get('/openapi.json', lazyOpenApiRouteHandler(app, publicOpenApiOptions));

	app.post(
		'/workflows/:name',
		describeRoute(workflowRouteSpec() as DescribeRouteOptions),
		validated('param', WorkflowRouteParamSchema),
		validated('query', WorkflowInvocationQuerySchema),
		workflowRouteHandler,
	);
	app.get('/workflows/:name', workflowSocketRouteHandler);
	app.all('/workflows/:name', workflowRouteHandler);

	app.post(
		'/agents/:name/:id',
		describeRoute(agentRouteSpec() as DescribeRouteOptions),
		validated('param', AgentRouteParamSchema),
		agentRouteHandler,
	);
	app.get('/agents/:name/:id', agentSocketRouteHandler);
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
				description: 'Public Flue agent invocation and workflow run inspection API.',
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

function workflowRouteSpec() {
	return {
		tags: ['workflows'],
		operationId: 'invokeWorkflow',
		summary: 'Start a workflow run',
		description:
			'Starts the named HTTP-exposed workflow through one admitted execution path. By default it returns an accepted run id; use ?wait=result for a synchronous JSON observation or Accept: text/event-stream to observe live run events while the connection remains available.',
		requestBody: {
			required: false,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						additionalProperties: true,
						description: 'Workflow-defined payload. Consult the target workflow documentation.',
					},
				},
			},
		},
		responses: {
			202: jsonResponse(WorkflowAdmissionResponseSchema, 'Workflow run accepted.'),
			200: {
				description:
					'Workflow result envelope or server-sent events stream, depending on the requested mode.',
				content: {
					'application/json': {
						schema: resolver(WorkflowInvocationResponseSchema),
					},
					'text/event-stream': {
						schema: {
							type: 'string',
							description:
								'SSE-framed FlueEvent values. A terminal stream-infrastructure event: error frame has data { error: { type, message, details, dev?, meta? } }.',
						},
					},
				},
			},
			...errorResponses(),
		},
		'x-flue-invocation-modes': ['accepted', 'wait-result', 'stream'],
		'x-flue-user-defined': true,
	};
}

function agentRouteSpec() {
	return {
		tags: ['agents'],
		operationId: 'invokeAgent',
		summary: 'Invoke an agent instance',
		description:
			'Prompts the named agent instance as an attached interaction. Use dispatch(...) from application code for asynchronous delivery.',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['message'],
						properties: {
							message: { type: 'string' },
						},
					},
				},
			},
		},
		responses: {
			200: {
				description:
					'Attached prompt result or server-sent events stream, depending on the requested mode.',
				content: {
					'application/json': {
						schema: resolver(AgentInvocationResponseSchema),
					},
					'text/event-stream': {
						schema: {
							type: 'string',
							description:
								'SSE frames for attached agent events correlated by instanceId without workflow run identity. A terminal event: error frame has data { type: "error", instanceId, error: { type, message, details, dev?, meta? } }.',
						},
					},
				},
			},
			...errorResponses(),
		},
		'x-flue-invocation-modes': ['sync', 'stream'],
		'x-flue-user-defined': true,
	};
}

function runRouteSpec(action: HandleRunRouteOptions['action']) {
	if (action === 'stream') {
		return {
			tags: ['runs'],
			operationId: 'streamRunEvents',
			summary: 'Stream workflow run events',
			responses: {
				200: {
					description:
						'Server-sent events stream of workflow run lifecycle and nested agent events.',
					content: {
						'text/event-stream': {
							schema: {
								type: 'string',
								description:
									'SSE-framed workflow run FlueEvent values. A terminal stream-infrastructure event: error frame has data { error: { type, message, details, dev?, meta? } }.',
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
		summary: action === 'get' ? 'Get a workflow run record' : 'List workflow run events',
		responses: {
			200: jsonResponse(
				action === 'get' ? RunRecordSchema : RunEventListResponseSchema,
				action === 'get' ? 'Run record.' : 'Persisted run event page.',
			),
			...errorResponses(),
		},
	};
}

const workflowSocketRouteHandler: MiddlewareHandler = async (c, next) => {
	if (!isWebSocketUpgrade(c.req.raw)) return next();
	const rt = requiredRuntime();
	const name = c.req.param('name') ?? '';
	if (!registeredWorkflowsForTransport(rt, 'websocket').includes(name)) {
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	}
	return runAttachedMiddleware(c, rt.workflowWebSocketMiddleware?.[name], async () => {
		if (rt.target === 'node') {
			if (!rt.nodeWebSocketWorkflowRoute)
				throw new Error('[flue] Node runtime is missing WebSocket workflow routing.');
			return (await rt.nodeWebSocketWorkflowRoute(c, next)) ?? undefined;
		}
		if (!rt.routeWorkflowRequest)
			throw new Error('[flue] Cloudflare runtime is missing workflow route forwarding.');
		const response = await rt.routeWorkflowRequest(
			normalizeAttachedRequest(c.req.raw, `/workflows/${encodeURIComponent(name)}`),
			c.env,
			{
				workflowName: name,
				instanceId: generateWorkflowRunId(name),
			},
		);
		if (response) return response;
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	});
};

const agentSocketRouteHandler: MiddlewareHandler = async (c, next) => {
	if (!isWebSocketUpgrade(c.req.raw)) return next();
	const rt = requiredRuntime();
	const name = c.req.param('name') ?? '';
	const id = c.req.param('id') ?? '';
	if (!registeredAgentsForTransport(rt, 'websocket').includes(name) || id.trim() === '') {
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	}
	return runAttachedMiddleware(c, rt.agentWebSocketMiddleware?.[name], async () => {
		if (rt.target === 'node') {
			if (!rt.nodeWebSocketAgentRoute)
				throw new Error('[flue] Node runtime is missing WebSocket agent routing.');
			return (await rt.nodeWebSocketAgentRoute(c, next)) ?? undefined;
		}
		if (!rt.routeAgentRequest)
			throw new Error('[flue] Cloudflare runtime is missing agent route forwarding.');
		const response = await rt.routeAgentRequest(
			normalizeAttachedRequest(
				c.req.raw,
				`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
			),
			c.env,
			{ agentName: name, instanceId: id },
		);
		if (response) return response;
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	});
};

const workflowRouteHandler: MiddlewareHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}

	const name = c.req.param('name') ?? '';
	const workflows = rt.manifest?.workflows ?? [];
	validateWorkflowRequest({
		method: c.req.method,
		name,
		registeredWorkflows: workflows.map((workflow) => workflow.name),
		httpWorkflows: registeredWorkflowsForTransport(rt, 'http'),
	});
	const request = c.req.raw.clone();

	return runAttachedMiddleware(c, rt.workflowRouteMiddleware?.[name], async () => {
		if (rt.target === 'node') {
			const handler = rt.workflowHandlers?.[name];
			const createContext = rt.createContext;
			if (!handler || !createContext) {
				throw new Error('[flue] Node runtime is missing workflow handler configuration.');
			}
			return handleWorkflowRequest({
				request,
				workflowName: name,
				handler,
				createContext,
				startWorkflowAdmission: rt.startWorkflowAdmission,
				runStore: rt.runStore,
				runSubscribers: rt.runSubscribers,
				runRegistry: rt.runRegistry,
				eventStreamStore: rt.eventStreamStore,
			});
		}

		if (!rt.routeWorkflowRequest) {
			throw new Error('[flue] Cloudflare runtime is missing workflow route forwarding.');
		}
		// One workflow run = one workflow DO instance. The instanceId IS the
		// runId; the DO it lands on then re-uses that value to seed its run
		// record via handleWorkflowRequest({ runId: instanceId, ... }).
		const response = await rt.routeWorkflowRequest(
			normalizeAttachedRequest(request, `/workflows/${encodeURIComponent(name)}`),
			c.env,
			{
				workflowName: name,
				instanceId: generateWorkflowRunId(name),
			},
		);
		if (response) return response;
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	});
};

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
		registeredAgents: registeredAgentsForTransport(rt, 'http'),
	});
	const request = c.req.raw.clone();

	return runAttachedMiddleware(c, rt.agentRouteMiddleware?.[name], async () => {
		if (rt.target === 'node') {
			const admitAttachedSubmission = rt.createAdmission?.[name]?.(id);
			if (!admitAttachedSubmission) {
				throw new Error('[flue] Node runtime is missing agent admission configuration.');
			}
			return handleAgentRequest({
				request,
				id,
				admitAttachedSubmission,
			});
		}

		if (!rt.routeAgentRequest) {
			throw new Error('[flue] Cloudflare runtime is missing agent route forwarding.');
		}
		const response = await rt.routeAgentRequest(request, c.env, {
			agentName: name,
			instanceId: id,
		});
		if (response) return response;

		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	});
};

function runByIdRouteHandler(action: HandleRunRouteOptions['action']): MiddlewareHandler {
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

		const response = await rt.routeRunRequest(
			normalizeRunRequest(request, runId, action),
			env,
			pointer.owner,
		);
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
		owner: pointer.owner,
		runId,
		action,
	});
}

function lazyOpenApiRouteHandler(
	app: Hono,
	getOptions: () => ReturnType<typeof publicOpenApiOptions>,
): MiddlewareHandler {
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

function requiredRuntime(): FlueRuntime {
	if (!runtimeConfig) {
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}
	return runtimeConfig;
}

async function runAttachedMiddleware(
	c: Parameters<MiddlewareHandler>[0],
	middleware: MiddlewareHandler | undefined,
	handle: () => Promise<Response | undefined>,
): Promise<Response | undefined> {
	if (!middleware) return handle();
	const finalizedBefore = c.finalized;
	const responseBefore = finalizedBefore ? c.res : undefined;
	let continued = false;
	const response = await middleware(c, async () => {
		if (continued) throw new Error('next() called multiple times');
		continued = true;
		const handled = await handle();
		if (handled) c.res = handled;
	});
	if (response) return response;
	if (continued || (c.finalized && (!finalizedBefore || c.res !== responseBefore))) return c.res;
	throw new Error(
		'Context is not finalized. Did you forget to return a Response object or await next()?',
	);
}

function isWebSocketUpgrade(request: Request): boolean {
	return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function normalizeAttachedRequest(request: Request, pathname: string): Request {
	const url = new URL(request.url);
	url.pathname = pathname;
	return new Request(url, request);
}

export function registeredAgentsForTransport(
	rt: FlueRuntime,
	transport: ExposedTransport,
): readonly string[] {
	return (rt.manifest?.agents ?? [])
		.filter((agent) => agent.transports[transport] === true)
		.map((agent) => agent.name);
}

export function registeredWorkflowsForTransport(
	rt: FlueRuntime,
	transport: ExposedTransport,
): readonly string[] {
	return (rt.manifest?.workflows ?? [])
		.filter((workflow) => workflow.transports[transport] === true)
		.map((workflow) => workflow.name);
}
