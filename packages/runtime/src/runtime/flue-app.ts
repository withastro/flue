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
	InvalidRequestError,
	MethodNotAllowedError,
	RouteNotFoundError,
	RunNotFoundError,
	RunRegistryUnavailableError,
	toHttpResponse,
	ValidationError,
	validateAgentRequest,
	validateWorkflowRequest,
} from '../errors.ts';
import type { ChannelWebhookHandler, Delivery, Dispatch, DispatchRequest } from '../types.ts';
import {
	type AgentHandler,
	type CreateContextFn,
	handleAgentRequest,
	handleWorkflowRequest,
	type RunHandlerFn,
	type StartWebhookFn,
	type WorkflowHandler,
} from './handle-agent.ts';
import { InMemoryDispatchQueue, type DispatchQueue } from './dispatch-queue.ts';
import { type HandleRunRouteOptions, handleRunRouteRequest } from './handle-run-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import type { RunPointer, RunRegistry } from './run-registry.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';
import {
	AgentInvocationResponseSchema,
	AgentRouteParamSchema,
	WorkflowInvocationQuerySchema,
	WorkflowRouteParamSchema,
	ErrorEnvelopeSchema,
	RunEventListResponseSchema,
	RunEventsQuerySchema,
	RunIdParamSchema,
	RunRecordSchema,
	WebhookInvocationResponseSchema,
	WorkflowAdmissionResponseSchema,
} from './schemas.ts';

export interface FlueRuntime {
	target: 'node' | 'cloudflare';

	/**
	 * Names of agents reachable over direct HTTP.
	 */
	webhookAgents: ReadonlyArray<string>;

	/**
	 * If true, the agent route accepts registered agents that are not listed in
	 * webhookAgents.
	 */
	allowNonWebhook: boolean;

	// ─── Node-only ──────────────────────────────────────────────────────────

	/**
	 * Map of agent name -> direct HTTP handler function.
	 */
	handlers?: Record<string, AgentHandler>;
	receiveHandlers?: Record<string, AgentReceiveHandler>;
	channelHandlers?: Record<string, ChannelWebhookHandler>;
	workflowHandlers?: Record<string, WorkflowHandler>;

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
	routeWorkflowRequest?: (
		request: Request,
		env: unknown,
		target: { workflowName: string; runId: string },
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
}

export interface FlueManifest {
	agents: Array<{
		name: string;
		channels: Record<string, true>;
		receive: boolean;
		init: boolean;
	}>;
	workflows?: Array<{
		name: string;
		channels: { http?: boolean; websocket?: boolean };
	}>;
}

export type DispatchFn = Dispatch;
export type AgentReceiveHandler = (ctx: {
	delivery: Delivery;
	dispatch: DispatchFn;
}) => unknown | Promise<unknown>;

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

export async function receiveExternalDelivery(
	delivery: Delivery,
	options: { dispatchQueue?: DispatchQueue } = {},
): Promise<{ invoked: string[]; errors: Array<{ agent: string; error: unknown }> }> {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] receiveExternalDelivery() called before runtime was configured. ' +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}

	const invoked: string[] = [];
	const errors: Array<{ agent: string; error: unknown }> = [];
	const dispatchQueue = options.dispatchQueue ?? rt.dispatchQueue ?? defaultDispatchQueue;
	for (const agent of rt.manifest?.agents ?? []) {
		if (!agent.channels[delivery.channel]) continue;
		const receive = rt.receiveHandlers?.[agent.name];
		if (!receive) {
			const error = new Error(`[flue] Agent "${agent.name}" is subscribed to "${delivery.channel}" but has no receive handler.`);
			errors.push({ agent: agent.name, error });
			console.error(error.message);
			continue;
		}
		invoked.push(agent.name);
		try {
			await receive({
				delivery,
				dispatch: createDispatchFn({
					delivery,
					sourceAgent: agent.name,
					dispatchQueue,
					rt,
				}),
			});
		} catch (error) {
			errors.push({ agent: agent.name, error });
			console.error(`[flue:receive] Agent "${agent.name}" receive() failed:`, error);
		}
	}
	return { invoked, errors };
}

const defaultDispatchQueue = new InMemoryDispatchQueue();

function createDispatchFn(options: {
	delivery: Delivery;
	sourceAgent: string;
	dispatchQueue: DispatchQueue;
	rt: FlueRuntime;
}): DispatchFn {
	return async (request) => {
		const targetAgent = request.agent ?? options.sourceAgent;
		const input = validateAndCloneDispatchRequest(request, targetAgent, options.rt);
		await options.dispatchQueue.enqueue({
			dispatchId: crypto.randomUUID(),
			deliveryId: options.delivery.id,
			sourceAgent: options.sourceAgent,
			targetAgent,
			agent: targetAgent,
			id: request.id,
			session: request.session,
			input,
			acceptedAt: new Date().toISOString(),
		});
	};
}

function validateAndCloneDispatchRequest(
	request: DispatchRequest,
	targetAgent: string,
	rt: FlueRuntime,
): unknown {
	if (typeof targetAgent !== 'string' || targetAgent.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty target agent.');
	}
	if (typeof request.id !== 'string' || request.id.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "id" target agent instance id.');
	}
	if (typeof request.session !== 'string' || request.session.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "session" target session id.');
	}
	if (request.input === undefined) {
		throw new Error('[flue] dispatch() requires an "input" payload. Use null for an intentional empty payload.');
	}
	if (!agentExists(rt, targetAgent)) {
		throw new Error(`[flue] dispatch() target agent "${targetAgent}" is not registered.`);
	}
	return cloneJsonSerializable(request.input, 'dispatch().input');
}

function agentExists(rt: FlueRuntime, agentName: string): boolean {
	return (rt.manifest?.agents ?? []).some((agent) => agent.name === agentName);
}

function cloneJsonSerializable(value: unknown, label: string): unknown {
	assertJsonLike(value, label, new WeakSet());
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(`[flue] ${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	return JSON.parse(json) as unknown;
}

function assertJsonLike(value: unknown, path: string, seen: WeakSet<object>): void {
	if (value === null) return;
	const type = typeof value;
	if (type === 'string' || type === 'number' || type === 'boolean') {
		if (type === 'number' && !Number.isFinite(value)) {
			throw new Error(`[flue] ${path} must not contain non-finite numbers.`);
		}
		return;
	}
	if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
		throw new Error(`[flue] ${path} must not contain ${type} values.`);
	}
	if (typeof value !== 'object') return;
	if (seen.has(value)) throw new Error(`[flue] ${path} must not contain circular references.`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) assertJsonLike(value[i], `${path}[${i}]`, seen);
		seen.delete(value);
		return;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(`[flue] ${path} must contain only plain JSON objects, arrays, strings, numbers, booleans, or null.`);
	}
	for (const [key, child] of Object.entries(value)) {
		assertJsonLike(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}

/**
 * Importable from `@flue/runtime/app`.
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
		'/channels/:channel',
		externalChannelRouteHandler,
	);
	app.all('/channels/:channel', externalChannelRouteHandler);

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

async function externalChannelRouteHandler(c: any): Promise<Response> {
	const rt = runtimeConfig;
	const channel = c.req.param('channel');
	if (c.req.method !== 'POST') {
		throw new MethodNotAllowedError({ method: c.req.method, allowed: ['POST'] });
	}
	if (!rt) {
		throw new Error('[flue] Runtime is not configured.');
	}
	const handler = rt.channelHandlers?.[channel];
	if (!handler) {
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	}
	const delivery = await handler.receive(c.req.raw, c.env);
	if (delivery.channel !== channel) {
		throw new InvalidRequestError({ reason: `Channel handler returned delivery for "${delivery.channel}" while handling "${channel}".` });
	}
	const result = await receiveExternalDelivery(delivery);
	return new Response(JSON.stringify({ accepted: true, ...result }), {
		status: 202,
		headers: { 'content-type': 'application/json' },
	});
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

function workflowRouteSpec() {
	return {
		tags: ['workflows'],
		operationId: 'invokeWorkflow',
		summary: 'Start a workflow run',
		description:
			'Starts the named HTTP-exposed workflow and returns an accepted run id by default.',
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
				description: 'Workflow result envelope or server-sent events stream, depending on the requested mode.',
				content: {
					'application/json': {
						schema: resolver(AgentInvocationResponseSchema),
					},
					'text/event-stream': {
						schema: { type: 'string', description: 'SSE-framed FlueEvent values.' },
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
		httpWorkflows: rt.allowNonWebhook
			? workflows.map((workflow) => workflow.name)
			: workflows.filter((workflow) => workflow.channels.http).map((workflow) => workflow.name),
	});

	if (rt.target === 'node') {
		const handler = rt.workflowHandlers?.[name];
		const createContext = rt.createContext;
		if (!handler || !createContext) {
			throw new Error('[flue] Node runtime is missing workflow handler configuration.');
		}
		return handleWorkflowRequest({
			request: c.req.raw,
			workflowName: name,
			handler,
			createContext,
			startWebhook: rt.startWebhook,
			runHandler: rt.runHandler,
			runStore: rt.runStore,
			runSubscribers: rt.runSubscribers,
			runRegistry: rt.runRegistry,
		});
	}

	if (!rt.routeWorkflowRequest) {
		throw new Error('[flue] Cloudflare runtime is missing workflow route forwarding.');
	}
	const response = await rt.routeWorkflowRequest(c.req.raw.clone(), c.env, {
		workflowName: name,
		runId: generateWorkflowRunId(name),
	});
	if (response) return response;
	throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
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
	const response = await rt.routeAgentRequest(c.req.raw.clone(), c.env);
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
	 *   - Node: every entry in the direct handler map.
 *   - Cloudflare: only direct-route agents have generated DO classes, so
 *     external-channel-only names have no valid landing target.
 */
function registeredAgentsFor(rt: FlueRuntime): readonly string[] {
	if (rt.target === 'node') return Object.keys(rt.handlers ?? {});
	return rt.webhookAgents;
}
