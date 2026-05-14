/**
 * Node-specific entry point for `@flue/runtime`. Exports the `local()`
 * sandbox factory for use in `init({ sandbox: local(...) })`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/runtime`.
 */
export { local, type LocalSandboxOptions } from './local.ts';
