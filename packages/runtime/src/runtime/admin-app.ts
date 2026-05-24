/** Admin Hono sub-app exposing Flue's read-only deployment inspection routes. */

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
	RouteNotFoundError,
	RunRegistryUnavailableError,
	toHttpResponse,
	ValidationError,
} from '../errors.ts';
import { type FlueRuntime, getFlueRuntime, handleRunById } from './flue-app.ts';
import type { ListRunsOpts, RunRegistry } from './run-registry.ts';
import type { RunStatus } from './run-store.ts';
import {
	AdminRunsQuerySchema,
	ErrorEnvelopeSchema,
	ListAgentsResponseSchema,
	ListRunsResponseSchema,
	RunIdParamSchema,
	RunRecordSchema,
} from './schemas.ts';

export function admin(): Hono {
	const app = new Hono();

	app.get('/openapi.json', lazyOpenApiRouteHandler(app, adminOpenApiOptions));
	app.get('/agents', describeRoute(adminAgentsSpec() as DescribeRouteOptions), listAgentsHandler);
	app.get(
		'/runs',
		describeRoute(adminRunsSpec() as DescribeRouteOptions),
		validated('query', AdminRunsQuerySchema),
		listRunsHandler,
	);
	app.get(
		'/runs/:runId',
		describeRoute(adminRunDetailSpec() as DescribeRouteOptions),
		validated('param', RunIdParamSchema),
		runDetailHandler,
	);

	app.onError((err) => toHttpResponse(err));
	return app;
}

function adminOpenApiOptions() {
	return {
		documentation: {
			info: {
				title: 'Flue Admin API',
				version: getFlueRuntime()?.runtimeVersion ?? '0.0.0',
				description: 'Read-only Flue deployment inspection API.',
			},
			servers: [],
		},
	};
}

function lazyOpenApiRouteHandler(app: Hono, getOptions: () => ReturnType<typeof adminOpenApiOptions>): MiddlewareHandler {
	return (c, next) => openAPIRouteHandler(app, getOptions())(c, next);
}

function validated(target: 'param' | 'query', schema: Parameters<typeof validator>[1]): MiddlewareHandler {
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
		content: { 'application/json': { schema: resolver(schema) } },
	};
}

function errorResponses() {
	return {
		400: jsonResponse(ErrorEnvelopeSchema, 'Validation or request-shape error.'),
		404: jsonResponse(ErrorEnvelopeSchema, 'Resource or route not found.'),
		500: jsonResponse(ErrorEnvelopeSchema, 'Internal server error.'),
		501: jsonResponse(ErrorEnvelopeSchema, 'Runtime feature is not configured.'),
	};
}

const listResponseDescription = 'Cursor-paginated list response.';

function adminAgentsSpec() {
	return {
		tags: ['admin'],
		operationId: 'adminListAgents',
		summary: 'List built agents',
		responses: {
			200: jsonResponse(ListAgentsResponseSchema, listResponseDescription),
			...errorResponses(),
		},
	};
}

function adminRunsSpec() {
	return {
		tags: ['admin'],
		operationId: 'adminListRuns',
		summary: 'List workflow runs across the deployment',
		responses: {
			200: jsonResponse(ListRunsResponseSchema, listResponseDescription),
			...errorResponses(),
		},
	};
}

function adminRunDetailSpec() {
	return {
		tags: ['admin'],
		operationId: 'adminGetRun',
		summary: 'Get a workflow run record',
		responses: {
			200: jsonResponse(RunRecordSchema, 'Run record.'),
			...errorResponses(),
		},
	};
}

const listAgentsHandler: MiddlewareHandler = async (c) => {
	const rt = requireRuntime();
	return c.json({ items: rt.manifest?.agents ?? [] });
};

const listRunsHandler: MiddlewareHandler = async (c) => {
	const rt = requireRuntime();
	const registry = requireRegistry(rt, c.env);
	const url = new URL(c.req.url);
	const opts: ListRunsOpts = {
		...parseListQuery(c.req.raw),
		status: statusFromRequest(c.req.raw),
	};
	const workflowName = url.searchParams.get('workflowName');
	if (workflowName) opts.workflowName = workflowName;
	const out = await registry.listRuns(opts);
	return c.json({ items: out.runs, nextCursor: out.nextCursor });
};

const runDetailHandler: MiddlewareHandler = async (c) => {
	const rt = requireRuntime();
	const runId = c.req.param('runId') ?? '';
	if (!runId) {
		throw new RouteNotFoundError({ method: c.req.method, path: new URL(c.req.url).pathname });
	}
	return handleRunById({
		rt,
		request: rewriteToPublicRunRequest(c.req.raw, runId),
		env: c.env,
		runId,
		action: 'get',
	});
};

function rewriteToPublicRunRequest(request: Request, runId: string): Request {
	const url = new URL(request.url);
	url.pathname = `/runs/${encodeURIComponent(runId)}`;
	return new Request(url, request);
}

function requireRuntime(): FlueRuntime {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			'[flue] admin() route invoked before runtime was configured. ' +
				'This usually means admin() was used outside a Flue-built server entry.',
		);
	}
	return rt;
}

function requireRegistry(rt: FlueRuntime, env: unknown): RunRegistry {
	if (rt.target === 'cloudflare') {
		const registry = rt.createRunRegistryForRequest?.(env);
		if (!registry) throw new RunRegistryUnavailableError();
		return registry;
	}
	if (!rt.runRegistry) throw new RunRegistryUnavailableError();
	return rt.runRegistry;
}

function parseListQuery(request: Request): { cursor?: string; limit?: number } {
	const params = new URL(request.url).searchParams;
	const out: { cursor?: string; limit?: number } = {};
	const cursor = params.get('cursor');
	if (cursor) out.cursor = cursor;
	const limit = params.get('limit');
	if (limit) out.limit = Number.parseInt(limit, 10);
	return out;
}

function statusFromRequest(request: Request): RunStatus | undefined {
	const status = new URL(request.url).searchParams.get('status');
	return status === 'active' || status === 'completed' || status === 'errored'
		? status
		: undefined;
}
