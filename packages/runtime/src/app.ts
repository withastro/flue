/**
 * Public surface for user-authored `app.ts` entries.
 *
 * Runtime-safe imports for user-authored app entries. Keep this subpath free
 * of build-only dependencies; `app.ts` may be bundled for Workers.
 *
 *     import {
 *       flue,
 *       registerProvider,
 *       configureProvider,
 *       type Fetchable,
 *     } from '@flue/runtime/app';
 *     import { Hono } from 'hono';
 *
 *     registerProvider('my-anthropic', {
 *       api: 'openai-completions',
 *       baseUrl: 'https://api.anthropic.com/v1',
 *       apiKey: process.env.ANTHROPIC_API_KEY,
 *     });
 *
 *     configureProvider('anthropic', {
 *       baseUrl: process.env.ANTHROPIC_BASE_URL,
 *       apiKey: process.env.ANTHROPIC_API_KEY,
 *     });
 *
 *     const app = new Hono();
 *     app.use('*', logger());
 *     app.route('/', flue());
 *     export default app;
 *
 */
export { flue } from './runtime/flue-app.ts';
export { admin } from './runtime/admin-app.ts';
export {
	registerProvider,
	registerApiProvider,
	configureProvider,
	type ProviderRegistration,
	type ProviderConfiguration,
	type HttpProviderRegistration,
	type CloudflareAIBindingRegistration,
	type CloudflareAIBinding,
} from './runtime/providers.ts';
export { observe, type FlueEventSubscriber } from './runtime/events.ts';

/**
 * Shape contract for a user-authored `app.ts` default export. Any
 * object exposing a `fetch(request, env?, ctx?)` method satisfies it,
 * including a `new Hono()` instance.
 *
 * The `env` and `ctx` parameters are passed through on the Cloudflare
 * target (env = bindings, ctx = ExecutionContext); on Node they are
 * undefined.
 */
export interface Fetchable {
	fetch(
		request: Request,
		env?: unknown,
		ctx?: unknown,
	): Response | Promise<Response>;
}
