/**
 * Cloudflare environment context injection. Safe because each DO is single-threaded.
 * Set before handler invocation, accessed by runtime primitives, cleared after.
 */

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

let currentContext: CloudflareContext | null = null;

export function setCloudflareContext(ctx: CloudflareContext): void {
	currentContext = ctx;
}

export function getCloudflareContext(): CloudflareContext {
	if (!currentContext) {
		throw new Error(
			'[flue:cloudflare] Not running in a Cloudflare context. ' +
				'This function can only be called inside a Cloudflare Worker or Durable Object.',
		);
	}
	return currentContext;
}

export function clearCloudflareContext(): void {
	currentContext = null;
}
