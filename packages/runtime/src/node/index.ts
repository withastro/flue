/**
 * Node-specific entry point for `@flue/runtime`. Exports the `local()`
 * sandbox factory for use in `createAgent(() => ({ sandbox: local(...) }))`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/runtime`.
 */
export { serve } from '@hono/node-server';
export { type LocalSandboxOptions, local } from './local.ts';
export {
	createNodeWebSocketTransport,
	type NodeWebSocketTransport,
	type NodeWebSocketTransportOptions,
} from './websocket.ts';
