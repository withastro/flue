/**
 * Node-specific entry point for `@flue/core`. Exports node-only helpers
 * such as `createLocalSessionEnv`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/core/client`.
 */
export { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';
