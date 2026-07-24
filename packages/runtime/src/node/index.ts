/**
 * Node-specific entry point for `@flue/runtime`. Exports the `local()`
 * sandbox factory for use in `useSandbox(local(...))`,
 * and the built-in `sqlite()` persistence adapter.
 *
 * Import platform-agnostic types (`FlueEventContext`, `PersistenceAdapter`, etc.)
 * from `@flue/runtime`.
 */
export { sqlite } from './agent-execution-store.ts';
export { type LocalSandboxOptions, local } from './local.ts';
export {
	type Flue,
	type StartAgentConfig,
	type StartAgentEntry,
	type StartOptions,
	start,
} from './start.ts';
