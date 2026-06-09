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
import { handleStreamHead, handleStreamRead } from './handle-stream-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import type { RunPointer, RunRegistry } from './run-registry.ts';
import type { EventStreamStore } from './event-stream-store.ts';
import type { RunStore } from './run-store.ts';

import {
	AgentInvocationResponseSchema,
	AgentRouteParamSchema,
	ErrorEnvelopeSchema,
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
	workflowRouteMiddleware?: Record<string, MiddlewareHandler>;

	/**
	 * Per-target context factory. Required when {@link target} is `'node'`.
	 */
	createContext?: CreateContextFn;

	/** Optional Node HTTP workflow admitted execution wrapper. Defaults to direct invocation. */
	startWorkflowAdmission?: StartWorkflowAdmissionFn;

	/**
	 * Per-agent durable admission factory, keyed by agent name. Direct HTTP
	 * prompts are persisted as durable submissions. Each factory receives the
	 * instance ID from the route and returns the admission hook for that
	 * specific agent instance. Created by the Node coordinator's
	 * `createAdmission()`.
	 */
	createAdmission?: Record<string, (instanceId: string) => AttachedAgentSubmissionAdmission>;

	/** Node workflow-run history store. */
	runStore?: RunStore;

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
		transports: { http?: true };
		created: boolean;
	}>;
	workflows?: Array<{
		name: string;
		transports: { http?: boolean };
	}>;
}



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
 * Creates a mountable Hono sub-app for Flue's public HTTP API.
 * Routes are relative to the application-chosen mount prefix.
 *
 * The mounted sub-app exposes:
 *
 * - `GET /openapi.json`
 * - `POST /agents/:name/:id` — send a prompt (sync JSON response)
 * - `GET/HEAD /agents/:name/:id` — DS event stream read
 * - `POST /workflows/:name` — start a workflow run
 * - `GET/HEAD /runs/:runId` — DS run event stream read
 *
 * Agent and workflow routes are available only when the corresponding module
 * opts into HTTP transport. Event streams use the Durable Streams protocol
 * (catch-up, long-poll, SSE) and are read-only.
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
	app.all('/workflows/:name', workflowRouteHandler);

	app.post(
		'/agents/:name/:id',
		describeRoute(agentRouteSpec() as DescribeRouteOptions),
		validated('param', AgentRouteParamSchema),
		agentRouteHandler,
	);
	// Non-POSTs still reach the canonical Flue 405 envelope instead of
	// Hono's default 404 for unmatched methods.
	app.all('/agents/:name/:id', agentRouteHandler);
	// DS stream endpoints for run events.
	app.get('/runs/:runId', runStreamReadHandler);
	app.on('HEAD', '/runs/:runId', runStreamHeadHandler);
	app.all('/runs/:runId', runStreamReadHandler);

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
			'Starts the named HTTP-exposed workflow. By default returns an accepted run id (202); use ?wait=result for a synchronous JSON result. Observe run events via the Durable Streams GET endpoint at /runs/:runId.',
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
				description: 'Synchronous workflow result (?wait=result).',
				content: {
					'application/json': {
						schema: resolver(WorkflowInvocationResponseSchema),
					},
				},
			},
			...errorResponses(),
		},
		'x-flue-invocation-modes': ['accepted', 'wait-result'],
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
				description: 'Attached prompt result.',
				content: {
					'application/json': {
						schema: resolver(AgentInvocationResponseSchema),
					},
				},
			},
			...errorResponses(),
		},
		'x-flue-user-defined': true,
	};
}


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
		httpWorkflows: registeredWorkflowsForTransport(rt),
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
		registeredAgents: registeredAgentsForTransport(rt),
	});
	const request = c.req.raw.clone();

	// All agent routes (POST, GET, HEAD) go through attached middleware so
	// user-defined auth/rate-limiting applies to stream reads too.
	return runAttachedMiddleware(c, rt.agentRouteMiddleware?.[name], async () => {
		// DS stream read (GET/HEAD) — served directly for Node, forwarded for CF.
		if (c.req.method === 'GET' || c.req.method === 'HEAD') {
			const streamPath = `agents/${name}/${id}`;
			if (rt.target === 'node') {
				if (!rt.eventStreamStore) {
					return new Response(null, { status: 404 });
				}
				if (c.req.method === 'HEAD') {
					return handleStreamHead(rt.eventStreamStore, streamPath);
				}
				return handleStreamRead({ store: rt.eventStreamStore, path: streamPath, request });
			}

			// Cloudflare: forward to the agent DO.
			if (!rt.routeAgentRequest) {
				throw new Error('[flue] Cloudflare runtime is missing agent route forwarding.');
			}
			const response = await rt.routeAgentRequest(request, c.env, {
				agentName: name,
				instanceId: id,
			});
			if (response) return response;
			throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
		}

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

const runStreamReadHandler: MiddlewareHandler = async (c) => {
	const rt = requiredRuntime();
	const method = c.req.method;

	if (method !== 'GET' && method !== 'HEAD') {
		throw new MethodNotAllowedError({ method, allowed: ['GET', 'HEAD'] });
	}

	const runId = c.req.param('runId') || undefined;
	if (!runId) {
		throw new RouteNotFoundError({ method, path: new URL(c.req.url).pathname });
	}

	const streamPath = `runs/${runId}`;

	if (rt.target === 'node') {
		if (!rt.eventStreamStore) {
			return new Response(null, { status: 404 });
		}
		if (method === 'HEAD') {
			return handleStreamHead(rt.eventStreamStore, streamPath);
		}
		return handleStreamRead({ store: rt.eventStreamStore, path: streamPath, request: c.req.raw });
	}

	// Cloudflare: look up the run in the registry and forward to the owning DO.
	if (!rt.createRunRegistryForRequest || !rt.routeRunRequest) {
		throw new RunRegistryUnavailableError();
	}
	const registry = rt.createRunRegistryForRequest(c.env);
	if (!registry) throw new RunRegistryUnavailableError();
	const pointer = await registry.lookupRun(runId);
	if (!pointer) throw new RunNotFoundError({ runId });

	const response = await rt.routeRunRequest(c.req.raw, c.env, pointer.owner);
	if (response) return response;
	throw new RouteNotFoundError({ method, path: new URL(c.req.url).pathname });
};

const runStreamHeadHandler: MiddlewareHandler = runStreamReadHandler;

export async function handleRunById(opts: {
	rt: FlueRuntime;
	request: Request;
	env: unknown;
	runId: string;
}): Promise<Response> {
	const { rt, request, env, runId } = opts;
	if (rt.target === 'cloudflare') {
		if (!rt.createRunRegistryForRequest || !rt.routeRunRequest) {
			throw new RunRegistryUnavailableError();
		}
		const registry = rt.createRunRegistryForRequest(env);
		if (!registry) throw new RunRegistryUnavailableError();
		const pointer = await registry.lookupRun(runId);
		if (!pointer) throw new RunNotFoundError({ runId });

		const response = await rt.routeRunRequest(
			normalizeRunRequest(request, runId),
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
		owner: pointer.owner,
		runId,
		action: 'get',
	});
}

function lazyOpenApiRouteHandler(
	app: Hono,
	getOptions: () => ReturnType<typeof publicOpenApiOptions>,
): MiddlewareHandler {
	return (c, next) => openAPIRouteHandler(app, getOptions())(c, next);
}

function normalizeRunRequest(request: Request, runId: string): Request {
	const url = new URL(request.url);
	url.pathname = `/runs/${encodeURIComponent(runId)}`;
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

function normalizeAttachedRequest(request: Request, pathname: string): Request {
	const url = new URL(request.url);
	url.pathname = pathname;
	return new Request(url, request);
}

export function registeredAgentsForTransport(
	rt: FlueRuntime,
): readonly string[] {
	return (rt.manifest?.agents ?? [])
		.filter((agent) => agent.transports.http === true)
		.map((agent) => agent.name);
}

export function registeredWorkflowsForTransport(
	rt: FlueRuntime,
): readonly string[] {
	return (rt.manifest?.workflows ?? [])
		.filter((workflow) => workflow.transports.http === true)
		.map((workflow) => workflow.name);
}
