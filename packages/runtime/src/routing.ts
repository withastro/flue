/**
 * Runtime-safe application composition for the authored `app.ts` entrypoint.
 *
 * `app.ts` IS the route map: its default {@link Fetchable} export owns the
 * request pipeline and mounts agent and channel routers explicitly (e.g.
 * `app.route('/agents/triage', createAgentRouter(IssueTriage))`).
 */

export { createAgentRouter } from './runtime/registration.ts';

/**
 * Structural contract for the default export of an authored `app.ts` entry.
 * Any object exposing a compatible `fetch()` method satisfies it, including a
 * `new Hono()` instance.
 *
 * On Cloudflare, `env` contains bindings and `ctx` is the
 * `ExecutionContext`. On Node, `env` contains Hono's Node adapter bindings for
 * the incoming and outgoing messages, and `ctx` is `undefined`.
 */
export interface Fetchable {
	fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
