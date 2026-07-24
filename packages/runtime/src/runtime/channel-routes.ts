/**
 * Channel HTTP surface.
 *
 * A channel is an object exposing a declarative `routes` array
 * (`{ method, path, handler }`). {@link createChannelRouter} — the mountable
 * sub-app that channel packages expose as `channel.route()` for explicit
 * `app.route(...)` mounting — serves those routes through
 * {@link dispatchChannelRequest}, which owns the error envelopes
 * (`method_not_allowed` with an `Allow` header, `route_not_found`),
 * cross-realm Response normalization, and runtime activity-lease retention.
 */

import type { Context, Env, Handler } from 'hono';
import { Hono } from 'hono';
import { MethodNotAllowedError, RouteNotFoundError, toHttpResponse } from '../errors.ts';
import { getFlueRuntime } from './flue-app.ts';
import type { RuntimeActivityGate } from './runtime-activity-gate.ts';

/** One declarative channel route, as produced by every `create*Channel()` factory. */
export interface ChannelRouteDefinition<E extends Env = Env> {
	/** Uppercase HTTP method, e.g. `POST`. */
	readonly method: string;
	/** Mount-relative absolute path, e.g. `/events`. */
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Flattened dispatch map keyed by `"METHOD /path"`. */
type ChannelHandlerMap = Record<string, (c: Context, next: () => Promise<void>) => unknown>;

/**
 * Build a mountable Hono sub-app serving a channel's routes relative to the
 * mount point:
 *
 * ```ts
 * app.route('/channels/slack', slack.route()); // channel packages call this helper
 * // or directly:
 * app.route('/channels/slack', createChannelRouter(slack.routes));
 * ```
 *
 * Pure factory — no registration side effects; safe to call any number of
 * times. Route declarations are validated eagerly (invalid method/path/handler
 * shapes and duplicate routes throw here, mirroring the legacy build-time
 * validation). Unknown paths and the mount root render the canonical
 * `route_not_found` envelope; a known path with the wrong method renders
 * `method_not_allowed` with an `Allow` header.
 */
export function createChannelRouter<E extends Env = Env>(
	routes: readonly ChannelRouteDefinition<E>[],
): Hono<E> {
	const handlers = normalizeChannelRoutes(routes);
	const app = new Hono<E>();
	app.all('/:suffix{.+}', (c) =>
		dispatchChannelRequest({
			c,
			suffix: `/${c.req.param('suffix') ?? ''}`,
			handlers,
			// Resolved at request time so a router built before the runtime is
			// configured still participates in graceful-drain accounting.
			activityGate: getFlueRuntime()?.activityGate,
		}),
	);
	// The mount root itself is not a channel endpoint.
	app.all('/', (c) => {
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
	});
	app.onError((err) => toHttpResponse(err));
	return app;
}

/**
 * Validate a channel's declarative routes and flatten them into the dispatch
 * map. Semantics ported from the legacy generated-entry normalization: paths
 * must be absolute non-empty suffixes without query/fragment or dot segments,
 * methods must be uppercase ASCII, handlers callable, and `"METHOD /path"`
 * pairs unique.
 */
function normalizeChannelRoutes<E extends Env>(
	routes: readonly ChannelRouteDefinition<E>[],
): ChannelHandlerMap {
	if (!Array.isArray(routes) || routes.length === 0) {
		throw new Error('[flue] A channel must declare at least one route.');
	}
	const handlers: ChannelHandlerMap = {};
	for (const route of routes) {
		if (!route || typeof route !== 'object' || Array.isArray(route)) {
			throw new Error('[flue] Channel contains an invalid route declaration.');
		}
		if (typeof route.method !== 'string' || !/^[A-Z]+$/.test(route.method)) {
			throw new Error('[flue] Channel route method must contain only uppercase ASCII letters.');
		}
		if (
			typeof route.path !== 'string' ||
			route.path.length < 2 ||
			!route.path.startsWith('/') ||
			route.path.startsWith('//') ||
			route.path.includes('?') ||
			route.path.includes('#')
		) {
			throw new Error(
				'[flue] Channel route path must be a non-empty absolute suffix without a query or fragment.',
			);
		}
		const segments = route.path.split('/');
		if (segments.some((segment: string) => segment === '.' || segment === '..')) {
			throw new Error('[flue] Channel route path must remain beneath its channel mount.');
		}
		if (typeof route.handler !== 'function') {
			throw new Error('[flue] Channel route handler must be callable.');
		}
		const key = `${route.method} ${route.path}`;
		if (handlers[key] !== undefined) {
			throw new Error(`[flue] Channel declares duplicate route "${key}".`);
		}
		handlers[key] = route.handler as ChannelHandlerMap[string];
	}
	return handlers;
}

/**
 * Dispatch one request against a channel's flattened handler map on behalf of
 * {@link createChannelRouter}.
 */
async function dispatchChannelRequest(options: {
	c: Context;
	/** Mount-relative path, leading slash (the mount root is handled separately). */
	suffix: string;
	handlers: ChannelHandlerMap;
	activityGate?: RuntimeActivityGate | undefined;
}): Promise<Response> {
	const { c, suffix, handlers } = options;
	const handler = handlers[`${c.req.method} ${suffix}`];
	if (!handler) {
		const allowed = Object.keys(handlers)
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

	const lease = options.activityGate?.enter();
	let response: Response | undefined;
	try {
		response = normalizeFetchResponse(await handler(c, async () => {}));
		if (response?.body && lease) response = retainActivityLease(response, lease);
		else lease?.release();
	} catch (error) {
		lease?.release();
		throw error;
	}
	if (!response) {
		throw new TypeError(
			`[flue] Channel handler for ${c.req.method} ${suffix} must return a Response.`,
		);
	}
	return response;
}

/**
 * Keep the runtime's activity lease held until a streamed channel response
 * body settles, so graceful reload/drain waits for in-flight streams.
 */
function retainActivityLease(response: Response, lease: { release(): void }): Response {
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

/**
 * Accept a fetch Response from another JavaScript realm (a channel handler
 * bundled against its own copy of the platform classes) by re-wrapping it,
 * and reject Response-shaped impostors.
 */
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
