/**
 * Cloudflare environment context injection.
 *
 * Durable Objects are single-threaded, but async executions can still interleave
 * at await points. AsyncLocalStorage keeps Cloudflare runtime primitives scoped
 * to the request/fiber that invoked them instead of sharing a module global.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CloudflareContext {
	env: Record<string, any>;
	agentInstance: {
		state: any;
		setState(state: any): void;
	};
	storage: {
		sql: any;
	};
}

const contextStorage = new AsyncLocalStorage<CloudflareContext>();
let fallbackContext: CloudflareContext | null = null;

export function runWithCloudflareContext<T>(ctx: CloudflareContext, fn: () => T): T {
	return contextStorage.run(ctx, fn);
}

export function setCloudflareContext(ctx: CloudflareContext): void {
	fallbackContext = ctx;
}

export function getCloudflareContext(): CloudflareContext {
	const ctx = contextStorage.getStore() ?? fallbackContext;
	if (!ctx) {
		throw new Error(
			'[flue:cloudflare] Not running in a Cloudflare context. ' +
				'This function can only be called inside a Cloudflare Worker or Durable Object.',
		);
	}
	return ctx;
}

export function clearCloudflareContext(): void {
	fallbackContext = null;
}
