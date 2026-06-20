/**
 * Node-specific entry point for `@flue/runtime`. Exports the `local()`
 * sandbox factory for use in `defineAgent(() => ({ sandbox: local(...) }))`,
 * and the built-in `sqlite()` persistence adapter.
 *
 * Import platform-agnostic types (`FlueContext`, `PersistenceAdapter`, etc.)
 * from `@flue/runtime`.
 */
export { sqlite } from './agent-execution-store.ts';
export { type LocalSandboxOptions, local } from './local.ts';
