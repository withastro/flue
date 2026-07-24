/**
 * Ambient types for Flue's virtual modules. The `flue()` plugin resolves
 * these inside the application's Vite graph:
 *
 * - `virtual:flue/app`    → the user's app entry (`app.ts` default export)
 * - `virtual:flue/db`     → the user's `db.ts` default export, or `undefined`
 * - `virtual:flue/agents` → the scanned `'use agent'` module set
 * - `virtual:flue/server` → the Node bootstrap (src/bootstrap/node-server.ts)
 * - `virtual:flue/providers` → provider registration generated from config
 */

declare module 'virtual:flue/app' {
	/** The user's app.ts default export — anything with a Fetch handler. */
	const app: { fetch(request: Request, env?: unknown): Response | Promise<Response> };
	export default app;
}

declare module 'virtual:flue/db' {
	/** The user's db.ts default export, or `undefined` when no db entry exists. */
	const adapter: unknown;
	export default adapter;
}

declare module 'virtual:flue/agents' {
	export interface ScannedAgent {
		/** Agent identity (exported function name or `agentName` override); keys durable storage. */
		readonly identity: string;
		/** The agent function (the module's evaluated export). */
		readonly agent: unknown;
	}
	/** Scanned `'use agent'` agents, path-ordered. */
	export const scannedAgents: readonly ScannedAgent[];
}

declare module 'virtual:flue/providers' {
	// Side-effect module: registers the configured (or default) provider set.
}

declare module 'virtual:flue/server' {
	import type { FlueNodeServer, StartFlueNodeServerOptions } from './node-server.ts';
	export function startFlueNodeServer(
		options?: StartFlueNodeServerOptions,
	): Promise<FlueNodeServer>;
}
