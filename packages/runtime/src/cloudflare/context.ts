/**
 * Cloudflare environment context injection.
 *
 * Durable Objects are single-threaded, but async executions can still interleave
 * at await points. AsyncLocalStorage keeps Cloudflare runtime primitives scoped
 * to the request/fiber that invoked them instead of sharing a module global.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlStorage } from '../sql-storage.ts';

export interface CloudflareContext {
	env: Record<string, unknown>;
	storage: {
		sql: SqlStorage;
	};
	durableObjectIdentity?: FlueDurableObjectIdentity;
}

export interface FlueDurableObjectIdentity {
	/** Wrangler binding name, e.g. "FLUE_DRAFT_WORKFLOW". */
	bindingName: string;
	/** Durable Object class name, e.g. "FlueDraftWorkflow". */
	className: string;
	/** Instance name passed to idFromName/getAgentByName. */
	name: string;
	/** Durable Object id rendered by DurableObjectState.id.toString(). */
	id: string;
}

const contextStorage = new AsyncLocalStorage<CloudflareContext>();

export function runWithCloudflareContext<T>(ctx: CloudflareContext, fn: () => T): T {
	return contextStorage.run(ctx, fn);
}

export function getCloudflareContext(): CloudflareContext {
	const ctx = contextStorage.getStore();
	if (!ctx) {
		throw new Error(
			'[flue] Not running in a Cloudflare context. ' +
				'This function can only be called inside a Cloudflare Worker or Durable Object.',
		);
	}
	return ctx;
}

export function getDurableObjectIdentity(): FlueDurableObjectIdentity {
	const ctx = getCloudflareContext();
	if (!ctx.durableObjectIdentity) {
		throw new Error('[flue] Durable Object identity is not available in this Cloudflare context.');
	}
	return ctx.durableObjectIdentity;
}
