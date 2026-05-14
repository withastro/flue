/**
 * Node-specific entry point for `@flue/runtime`. Exports node-only helpers
 * such as the `local()` sandbox factory and `createLocalSessionEnv`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/runtime`.
 */
export { local, type LocalSandboxOptions } from './local.ts';
export {
	createLocalSessionEnv,
	DEFAULT_LOCAL_ENV_ALLOWLIST,
	type LocalSessionEnvOptions,
} from './local-env.ts';
