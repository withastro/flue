import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono-openapi';
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
	AgentDefinition,
	AgentDispatchRequest,
	DispatchReceipt,
	NamedAgentDispatchRequest,
	WorkflowRouteHandler,
	WorkflowRunsHandler,
} from '../types.ts';
import type { WorkflowDefinition } from '../workflow-definition.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from './conversation-stream-store.ts';
import { enqueueDispatch } from './dispatch.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { agentStreamPath, type EventStreamStore, runStreamPath } from './event-stream-store.ts';
import {
	type CreateWorkflowContextFn,
	handleAgentRequest,
	handleWorkflowRequest,
} from './handle-agent.ts';
import {
	handleAgentConversationHead,
	handleAgentConversationRead,
} from './handle-conversation-routes.ts';
import { handleStreamHead, handleStreamRead } from './handle-stream-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import { invokeWorkflow, type WorkflowInvocationReceipt, type WorkflowInvokeRequest } from './invoke.ts';
import type { RunStore, WorkflowRunPointer } from './run-store.ts';
import type { RuntimeActivityGate } from './runtime-activity-gate.ts';

import {
	AgentRouteParamSchema,
	InvocationQuerySchema,
	WorkflowRouteParamSchema,
} from './schemas.ts';

export interface AgentRecord {
	name: string;
	definition: AgentDefinition;
	description?: string;
	route?: MiddlewareHandler;
}

export interface WorkflowRecord {
	name: string;
	definition: WorkflowDefinition;
	route?: WorkflowRouteHandler;
	runs?: WorkflowRunsHandler;
}

interface RuntimeBase {
	devMode?: boolean;
	temporaryLocalExposure?: boolean;
	agents: AgentRecord[];
	workflows: WorkflowRecord[];
	channelHandlers?: Record<string, Record<string, (c: Context) => Response | Promise<Response>>>;
	dispatchQueue: DispatchQueue;
	admitWorkflow: (input: { workflowName: string; input: unknown }) => Promise<{ runId: string }>;
	activityGate?: RuntimeActivityGate;
}

export interface NodeRuntime extends RuntimeBase {
	target: 'node';
	createWorkflowContext: CreateWorkflowContextFn;
	createAgentAdmission: (
		agentName: string,
		instanceId: string,
	) => AttachedAgentSubmissionAdmission;
	runStore: RunStore;
	eventStreamStore: EventStreamStore;
	conversationStreamStore: ConversationStreamStore;
	conversationSnapshotStore: ConversationSnapshotStore;
}

export interface CloudflareRuntime extends RuntimeBase {
	target: 'cloudflare';
	routeAgentRequest: (
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
	routeWorkflowRequest: (
		request: Request,
		env: unknown,
		target: { workflowName: string; instanceId: string },
	) => Promise<Response | null>;

	/** Cloudflare-only forwarding hook for registry-resolved run requests. */
	routeRunRequest: (
		request: Request,
		env: unknown,
		target: { workflowName: string; runId: string },
	) => Promise<Response | null>;

	/**
	 * Cloudflare-only factory for the request-scoped run index client
	 * (cross-deployment lookup/listing over the `FlueRegistry` index DO).
	 */
	createRunIndexForRequest: (env: unknown) => RunListing | undefined;
}

export type FlueRuntime = NodeRuntime | CloudflareRuntime;

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
	const name = rt.agents.find((record) => record.definition === agent)?.name;
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

	app.post(
		'/workflows/:name',
		validated('param', WorkflowRouteParamSchema),
		validated('query', InvocationQuerySchema),
		workflowRouteHandler,
	);
	app.all('/workflows/:name', workflowRouteHandler);

	app.post(
		'/agents/:name/:id',
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

const workflowRouteHandler: MiddlewareHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] flue() route invoked before runtime was configured. ' +
				'This usually means flue() was used outside a Flue-built server entry.',
		);
	}

	const name = c.req.param('name') ?? '';
	validateWorkflowRequest({
		method: c.req.method,
		name,
		registeredWorkflows: rt.workflows.map((workflow) => workflow.name),
		httpWorkflows: registeredWorkflowsForTransport(rt),
	});
	const request = c.req.raw.clone();

	const record = rt.workflows.find((workflow) => workflow.name === name);
	return runAttachedMiddleware(c, record?.route, async () => {
		if (rt.target === 'node') {
			if (!record) throw new Error('[flue] Node runtime is missing workflow configuration.');
			return handleWorkflowRequest({
				request,
				workflowName: name,
				workflow: record.definition,
				createContext: rt.createWorkflowContext,
				runStore: rt.runStore,
				eventStreamStore: rt.eventStreamStore,
				activityGate: rt.activityGate,
			});
		}

		// One workflow run = one workflow DO instance. The instanceId IS the
		// runId; the DO it lands on then re-uses that value to seed its run
		// record via handleWorkflowRequest({ runId: instanceId, ... }).
		const response = await rt.routeWorkflowRequest(
			request,
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
	const record = rt.agents.find((agent) => agent.name === name);
	return runAttachedMiddleware(c, record?.route, async () => {
		// DS stream read (GET/HEAD) — served directly for Node, forwarded for CF.
		if (c.req.method === 'GET' || c.req.method === 'HEAD') {
			const streamPath = agentStreamPath(name, id);
			if (rt.target === 'node') {
				const view = new URL(request.url).searchParams.get('view');
				if (view) {
					if (c.req.method === 'HEAD') {
						return handleAgentConversationHead(rt.conversationStreamStore, streamPath);
					}
					return handleAgentConversationRead({
						store: rt.conversationStreamStore,
						snapshots: rt.conversationSnapshotStore,
						path: streamPath,
						request,
					});
				}
				return nodeStreamReadResponse(rt, c.req.method, streamPath, request);
			}

			// Cloudflare: forward to the agent DO.
			const response = await rt.routeAgentRequest(request, c.env, {
				agentName: name,
				instanceId: id,
			});
			if (response) return response;
			throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
		}

		if (rt.target === 'node') {
			const admitAttachedSubmission = rt.createAgentAdmission(name, id);
			if (!admitAttachedSubmission) {
				throw new Error('[flue] Node runtime is missing agent admission configuration.');
			}
			return handleAgentRequest({
				request,
				id,
				agentName: name,
				eventStreamStore: rt.eventStreamStore,
				admitAttachedSubmission,
			});
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

	const lease = rt.activityGate?.enter();
	let response: Response | undefined;
	try {
		response = normalizeFetchResponse(await handler(c));
		if (response?.body && lease) response = retainActivityLease(response, lease);
		else lease?.release();
	} catch (error) {
		lease?.release();
		throw error;
	}
	if (!response) {
		throw new TypeError(
			`[flue] Channel "${name}" handler for ${c.req.method} ${suffix} must return a Response.`,
		);
	}
	return response;
};

function retainActivityLease(
	response: Response,
	lease: { release(): void },
): Response {
	const body = response.body;
	if (!body) {
		lease.release();
		return response;
	}
	const reader = body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read();
					if (result.done) {
						lease.release();
						controller.close();
						return;
					}
					controller.enqueue(result.value);
				} catch (error) {
					lease.release();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					lease.release();
				}
			},
		}),
		{ status: response.status, statusText: response.statusText, headers: response.headers },
	);
}

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
	const runId = c.req.param('runId') ?? '';
	const pointer = await findRunPointer(rt, c.env, runId);
	const workflow = pointer
		? rt.workflows.find((record) => record.name === pointer.workflowName)
		: undefined;

	if (!workflow || (!workflow.runs && !rt.temporaryLocalExposure)) {
		throw new RunNotFoundError({ runId });
	}

	return runAttachedMiddleware(c, workflow.runs, async () => {
		if (method !== 'GET' && method !== 'HEAD') {
			throw new MethodNotAllowedError({ method, allowed: ['GET', 'HEAD'] });
		}

		const wantsMeta = method === 'GET' && new URL(c.req.url).searchParams.has('meta');

		if (rt.target === 'node') {
			if (wantsMeta) {
				return handleRunRouteRequest({
					runStore: rt.runStore,
					workflowName: workflow.name,
					runId,
				});
			}
			return nodeStreamReadResponse(rt, method, runStreamPath(runId), c.req.raw);
		}

		const response = await rt.routeRunRequest(c.req.raw, c.env, {
			workflowName: workflow.name,
			runId,
		});
		if (response) return response;
		throw new RunNotFoundError({ runId });
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

/** Serve a DS stream HEAD/GET from the Node runtime's store. */
function nodeStreamReadResponse(
	rt: NodeRuntime,
	method: string,
	streamPath: string,
	request: Request,
): Promise<Response> {
	const store = rt.eventStreamStore;
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
): Promise<WorkflowRunPointer | null> {
	if (rt.target === 'cloudflare') {
		const index = rt.createRunIndexForRequest(env);
		if (!index) throw new RunStoreUnavailableError();
		return index.lookupRun(runId);
	}
	return rt.runStore.lookupRun(runId);
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

function registeredAgentsForTransport(rt: FlueRuntime): readonly string[] {
	return rt.agents
		.filter((agent) => rt.temporaryLocalExposure || agent.route !== undefined)
		.map((agent) => agent.name);
}

function registeredWorkflowsForTransport(rt: FlueRuntime): readonly string[] {
	return rt.workflows
		.filter((workflow) => rt.temporaryLocalExposure || workflow.route !== undefined)
		.map((workflow) => workflow.name);
}
