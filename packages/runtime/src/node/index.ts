/**
 * Node-specific entry point for `@flue/runtime`. Exports node-only helpers
 * such as `createLocalSessionEnv`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/runtime`.
 */
export { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';
