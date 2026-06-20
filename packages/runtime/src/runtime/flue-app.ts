import { toJsonSchema } from '@valibot/to-json-schema';
import type { Context, MiddlewareHandler } from 'hono';
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
	InvalidRequestError,
	MethodNotAllowedError,
	RouteNotFoundError,
	RunNotFoundError,
	RunStoreUnavailableError,
	toHttpResponse,
	validateAgentRequest,
	validateWorkflowRequest,
} from '../errors.ts';
import type {
	AgentDispatchRequest,
	AgentDefinition,
	DispatchReceipt,
	NamedAgentDispatchRequest,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import { enqueueDispatch } from './dispatch.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { agentStreamPath, type EventStreamStore, runStreamPath } from './event-stream-store.ts';
import {
	type CreateContextFn,
	handleAgentRequest,
	handleWorkflowRequest,
	type WorkflowRegistry,
} from './handle-agent.ts';
import { handleStreamHead, handleStreamRead } from './handle-stream-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import { invokeWorkflow, type WorkflowInvokeRequest, type WorkflowInvocationReceipt } from './invoke.ts';
import type { WorkflowDefinition } from '../workflow-definition.ts';
import type { RunPointer, RunStore } from './run-store.ts';

import {
	AgentAdmissionResponseSchema,
	AgentInvocationResponseSchema,
	AgentRouteParamSchema,
	DirectAgentPayloadSchema,
	ErrorEnvelopeSchema,
	InvocationQuerySchema,
	WorkflowAdmissionResponseSchema,
	WorkflowInvocationResponseSchema,
	WorkflowRouteParamSchema,
} from './schemas.ts';

export interface FlueRuntime {
	target: 'node' | 'cloudflare';
	devMode?: boolean;

	// ─── Node-only ──────────────────────────────────────────────────────────

	workflows?: WorkflowRegistry;
	agentRouteMiddleware?: Record<string, MiddlewareHandler>;
	workflowRouteMiddleware?: Record<string, MiddlewareHandler>;
	channelHandlers?: Record<string, Record<string, (c: Context) => Response | Promise<Response>>>;

	/**
	 * Per-target context factory. Required when {@link target} is `'node'`.
	 */
	createContext?: CreateContextFn;

	/**
	 * Per-agent durable admission factory, keyed by agent name. Direct HTTP
	 * prompts are persisted as durable submissions. Each factory receives the
	 * instance ID from the route and returns the admission hook for that
	 * specific agent instance. Created by the Node coordinator's
	 * `createAdmission()`.
	 */
	createAdmission?: Record<string, (instanceId: string) => AttachedAgentSubmissionAdmission>;

	/** Node workflow-run store: records plus cross-run lookup and listing. */
	runStore?: RunStore;

	/**
	 * Durable event stream store for DS-compatible event persistence.
	 * Required when {@link target} is `'node'` — the generated Node entry
	 * always provides one. On Cloudflare, streams live in per-instance
	 * Durable Object stores instead, so the worker-level runtime has none.
	 */
	eventStreamStore?: EventStreamStore;

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
		target: { workflowName: string; runId: string },
	) => Promise<Response | null>;

	/**
	 * Cloudflare-only factory for the request-scoped run index client
	 * (cross-deployment lookup/listing over the `FlueRegistry` index DO).
	 */
	createRunIndexForRequest?: (env: unknown) => RunListing | undefined;

	/** Package version inlined by the generated entry for OpenAPI metadata. */
	runtimeVersion?: string;

	/** Build manifest inlined by the generated entry. */
	manifest?: FlueManifest;

	/** Internal dispatch admission queue. Defaults to process-lifetime memory. */
	dispatchQueue?: DispatchQueue;

	/** Resolve discovered/default-exported agent definition identities for global dispatch. */
	resolveDispatchAgentName?: (agent: AgentDefinition) => string | undefined;

	/** Resolve the exact discovered/default-exported Workflow Definition identity. */
	resolveWorkflowName?: (workflow: WorkflowDefinition) => string | undefined;

	/** Admit an ambient workflow invocation through the target runtime. */
	admitWorkflow?: (input: { workflowName: string; input: unknown }) => Promise<{ runId: string }>;
}

/** Cross-deployment run lookup/listing surface of a {@link RunStore}. */
export type RunListing = Pick<RunStore, 'lookupRun' | 'listRuns'>;

/** One built agent in the deployment manifest, as returned by `listAgents()`. */
export interface AgentManifestEntry {
	/** Addressable agent name — the `agents/<name>.ts` module name. */
	name: string;
	/** Static description from the agent module's `description` export. */
	description?: string;
	/** Transports the agent is exposed over. */
	transports: { http?: true };
	/** Whether the module default-exports an agent definition. */
	defined: boolean;
}

interface FlueManifest {
	agents: AgentManifestEntry[];
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
 * The agent-definition overload requires a value default-exported by exactly one
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
	agent: AgentDefinition,
	request: AgentDispatchRequest,
): Promise<DispatchReceipt>;
export function dispatch(request: NamedAgentDispatchRequest): Promise<DispatchReceipt>;
export async function dispatch(
	agentOrRequest: AgentDefinition | NamedAgentDispatchRequest,
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
	const request = isAgentDefinitionValue(agentOrRequest)
		? resolveAgentDefinitionDispatchRequest(agentOrRequest, maybeRequest, rt)
		: agentOrRequest;
	return enqueueDispatch({ request, dispatchQueue: rt.dispatchQueue, rt });
}

export function invoke<TWorkflow extends WorkflowDefinition>(
	workflow: TWorkflow,
	request: WorkflowInvokeRequest<TWorkflow>,
): Promise<WorkflowInvocationReceipt> {
	return invokeWorkflow(workflow, request, runtimeConfig);
}

function isAgentDefinitionValue(
	value: AgentDefinition | NamedAgentDispatchRequest,
): value is AgentDefinition {
	return (
		'__flueAgentDefinition' in value &&
		value.__flueAgentDefinition === true &&
		typeof value.initialize === 'function'
	);
}

function resolveAgentDefinitionDispatchRequest(
	agent: AgentDefinition,
	request: AgentDispatchRequest | undefined,
	rt: FlueRuntime,
): NamedAgentDispatchRequest {
	if (!request) throw new Error('[flue] dispatch(agent, request) requires a dispatch request.');
	const name = rt.resolveDispatchAgentName?.(agent);
	if (!name) {
		throw new Error(
			'[flue] dispatch() target agent definition is not a discovered default-exported agent in this built application.',
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
 * - `POST /agents/:name/:id` — send a prompt (202 admission; `?wait=result` for a sync JSON result)
 * - `GET/HEAD /agents/:name/:id` — DS event stream read
 * - `POST /workflows/:name` — start a workflow run (202 admission; `?wait=result` for a sync JSON result)
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
		validated('query', InvocationQuerySchema),
		workflowRouteHandler,
	);
	app.all('/workflows/:name', workflowRouteHandler);

	app.post(
		'/agents/:name/:id',
		describeRoute(agentRouteSpec() as DescribeRouteOptions),
		validated('param', AgentRouteParamSchema),
		validated('query', InvocationQuerySchema),
		agentRouteHandler,
	);
	// Non-POSTs still reach the canonical Flue 405 envelope instead of
	// Hono's default 404 for unmatched methods.
	app.all('/agents/:name/:id', agentRouteHandler);
	app.all('/channels/:name', channelRouteHandler);
	app.all('/channels/:name/:suffix{.+}', channelRouteHandler);
	// DS stream endpoints for run events.
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
		throw new InvalidRequestError({
			reason: `Invalid ${target} parameters: ${describeValidationIssues(result.error)}`,
		});
	}) as MiddlewareHandler;
}

/**
 * Flatten standard-schema validation issues into a caller-safe sentence.
 * The raw issue objects are a validation-library-internal shape and must not
 * reach the wire — clients would freeze that shape into their error handling.
 */
function describeValidationIssues(issues: unknown): string {
	if (!Array.isArray(issues) || issues.length === 0) return 'request validation failed.';
	return issues
		.map((issue: { message?: unknown; path?: unknown }) => {
			const message = typeof issue.message === 'string' ? issue.message : 'Invalid value.';
			const path = Array.isArray(issue.path)
				? issue.path
						.map((segment) =>
							typeof segment === 'object' && segment !== null && 'key' in segment
								? String((segment as { key: unknown }).key)
								: String(segment),
						)
						.join('.')
				: '';
			return path ? `${path}: ${message}` : message;
		})
		.join(' ');
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
						description: 'Workflow-defined input. Consult the target workflow documentation.',
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
			'Prompts the named agent instance as an attached interaction. By default returns accepted stream coordinates (202); use ?wait=result for a synchronous JSON result. Observe events via the Durable Streams GET endpoint at the same URL. Use dispatch(...) from application code for asynchronous delivery.',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: toJsonSchema(DirectAgentPayloadSchema, { errorMode: 'ignore' }),
				},
			},
		},
		responses: {
			202: jsonResponse(AgentAdmissionResponseSchema, 'Prompt accepted.'),
			200: {
				description: 'Synchronous prompt result (?wait=result).',
				content: {
					'application/json': {
						schema: resolver(AgentInvocationResponseSchema),
					},
				},
			},
			...errorResponses(),
		},
		'x-flue-invocation-modes': ['accepted', 'wait-result'],
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
			const workflow = rt.workflows?.[name];
			const createContext = rt.createContext;
			if (!workflow || !createContext) {
				throw new Error('[flue] Node runtime is missing workflow configuration.');
			}
			return handleWorkflowRequest({
				request,
				workflowName: name,
				workflow,
				createContext,
				runStore: rt.runStore,
				eventStreamStore: requireNodeEventStreamStore(rt),
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
				instanceId: generateWorkflowRunId(),
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
			const streamPath = agentStreamPath(name, id);
			if (rt.target === 'node') {
				return nodeStreamReadResponse(rt, c.req.method, streamPath, request);
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
				agentName: name,
				eventStreamStore: requireNodeEventStreamStore(rt),
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

const channelRouteHandler: MiddlewareHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}

	const name = c.req.param('name') ?? '';
	const remainder = c.req.param('suffix') ?? '';
	const suffix = remainder.length > 0 ? `/${remainder}` : '';
	const routes = rt.channelHandlers?.[name];
	if (!routes || suffix.length === 0) {
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	}

	const handler = routes[`${c.req.method} ${suffix}`];
	if (!handler) {
		const allowed = Object.keys(routes)
			.filter((key) => key.endsWith(` ${suffix}`))
			.map((key) => key.slice(0, key.indexOf(' ')));
		if (allowed.length > 0) {
			throw new MethodNotAllowedError({ method: c.req.method, allowed });
		}
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	}

	const response = normalizeFetchResponse(await handler(c));
	if (!response) {
		throw new TypeError(
			`[flue] Channel "${name}" handler for ${c.req.method} ${suffix} must return a Response.`,
		);
	}
	return response;
};

function normalizeFetchResponse(value: unknown): Response | undefined {
	if (value instanceof globalThis.Response) return value;
	if (Object.prototype.toString.call(value) !== '[object Response]') return undefined;
	if (typeof value !== 'object' || value === null) return undefined;
	try {
		const response = value as Response;
		if (
			!Number.isInteger(response.status) ||
			response.status < 200 ||
			response.status > 599 ||
			typeof response.statusText !== 'string' ||
			typeof response.headers?.entries !== 'function' ||
			(response.body !== null && typeof response.body !== 'object')
		) {
			return undefined;
		}
		return new globalThis.Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers),
		});
	} catch {
		return undefined;
	}
}

const runStreamReadHandler: MiddlewareHandler = async (c) => {
	const rt = requiredRuntime();
	const method = c.req.method;

	if (method !== 'GET' && method !== 'HEAD') {
		throw new MethodNotAllowedError({ method, allowed: ['GET', 'HEAD'] });
	}

	// Hono's `:runId` pattern never matches an empty segment.
	const runId = c.req.param('runId') ?? '';

	// Resolve the owning workflow before responding, but emit no
	// existence-derived response yet: per-workflow route middleware is the
	// user's auth boundary for run reads, so it must run before this route
	// discloses whether a run exists. Runs whose pointer is missing — or
	// whose workflow is no longer part of the current build — are uniformly
	// not servable: a stale pointer must not bypass the middleware of the
	// workflow that guarded it when the run was recorded.
	const pointer = await findRunPointer(rt, c.env, runId);
	const workflowName =
		pointer && isRegisteredWorkflow(rt, pointer.workflowName) ? pointer.workflowName : undefined;
	const middleware =
		workflowName === undefined ? undefined : rt.workflowRouteMiddleware?.[workflowName];

	return runAttachedMiddleware(c, middleware, async () => {
		if (workflowName === undefined) throw new RunNotFoundError({ runId });

		// `?meta` selects the run-record view of the same resource: plain
		// `RunRecord` JSON with no Durable Streams headers. Stream params
		// (`offset`, `live`) are ignored on this view.
		const wantsMeta = method === 'GET' && new URL(c.req.url).searchParams.has('meta');

		if (rt.target === 'node') {
			if (wantsMeta) {
				return handleRunRouteRequest({ runStore: rt.runStore, workflowName, runId });
			}
			return nodeStreamReadResponse(rt, method, runStreamPath(runId), c.req.raw);
		}

		const response = await rt.routeRunRequest?.(c.req.raw, c.env, { workflowName, runId });
		if (response) return response;
		throw new RouteNotFoundError({ method, path: new URL(c.req.url).pathname });
	});
};

export interface HandleRunRouteOptions {
	runStore?: RunStore;
	workflowName: string;
	runId: string;
}

/** Serve run metadata (`RunRecord`) for a workflow-scoped run lookup. */
export async function handleRunRouteRequest(opts: HandleRunRouteOptions): Promise<Response> {
	if (!opts.runStore) throw new RunStoreUnavailableError();
	const run = await opts.runStore.getRun(opts.runId);
	if (!run || run.workflowName !== opts.workflowName) {
		throw new RunNotFoundError({ runId: opts.runId });
	}
	return new Response(JSON.stringify(run), { headers: { 'content-type': 'application/json' } });
}

function lazyOpenApiRouteHandler(
	app: Hono,
	getOptions: () => ReturnType<typeof publicOpenApiOptions>,
): MiddlewareHandler {
	return (c, next) => openAPIRouteHandler(app, getOptions())(c, next);
}

/**
 * Resolve the event stream store on a Node-target runtime. The generated
 * Node entry always constructs one, so a missing store is a wiring bug —
 * fail loudly instead of masquerading as a missing stream/run.
 */
function requireNodeEventStreamStore(rt: FlueRuntime): EventStreamStore {
	if (!rt.eventStreamStore) {
		throw new Error(
			'[flue] Node runtime configured without an event stream store. ' +
				'The generated Node entry always provides one — this indicates a misconfigured runtime.',
		);
	}
	return rt.eventStreamStore;
}

/** Serve a DS stream HEAD/GET from the Node runtime's store. */
function nodeStreamReadResponse(
	rt: FlueRuntime,
	method: string,
	streamPath: string,
	request: Request,
): Promise<Response> {
	const store = requireNodeEventStreamStore(rt);
	if (method === 'HEAD') {
		return handleStreamHead(store, streamPath);
	}
	return handleStreamRead({ store, path: streamPath, request });
}

/**
 * Resolve a run pointer from the configured store/index, or `null` when no
 * run with this id is recorded. Throws {@link RunStoreUnavailableError} when
 * the runtime has no run store configured (a wiring problem, not a
 * resource-existence outcome).
 */
async function findRunPointer(
	rt: FlueRuntime,
	env: unknown,
	runId: string,
): Promise<RunPointer | null> {
	if (rt.target === 'cloudflare') {
		if (!rt.createRunIndexForRequest || !rt.routeRunRequest) {
			throw new RunStoreUnavailableError();
		}
		const index = rt.createRunIndexForRequest(env);
		if (!index) throw new RunStoreUnavailableError();
		return index.lookupRun(runId);
	}
	if (!rt.runStore) throw new RunStoreUnavailableError();
	return rt.runStore.lookupRun(runId);
}

function isRegisteredWorkflow(rt: FlueRuntime, workflowName: string): boolean {
	return (rt.manifest?.workflows ?? []).some((workflow) => workflow.name === workflowName);
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

function registeredAgentsForTransport(rt: FlueRuntime): readonly string[] {
	return (rt.manifest?.agents ?? [])
		.filter((agent) => agent.transports.http === true)
		.map((agent) => agent.name);
}

function registeredWorkflowsForTransport(rt: FlueRuntime): readonly string[] {
	return (rt.manifest?.workflows ?? [])
		.filter((workflow) => workflow.transports.http === true)
		.map((workflow) => workflow.name);
}
