/**
 * `local()` — Sandbox factory binding directly to the host on the Node target.
 *
 * Thin `SandboxFactory` wrapper around `createLocalSessionEnv` from
 * `./local-env.ts`. The helper holds the real implementation (host fs +
 * `child_process.spawn`, env allowlist resolution); this file just adapts
 * it to the public `defineAgent(() => ({ sandbox }))` surface that sandbox adapters plug into.
 *
 * For full semantics — env allowlist, cwd defaulting, `exec` env layering —
 * see `LocalSessionEnvOptions` and `DEFAULT_LOCAL_ENV_ALLOWLIST` in
 * `./local-env.ts`.
 */
import type { SandboxFactory } from '../types.ts';
import { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';

export type LocalSandboxOptions = LocalSessionEnvOptions;

export function local(options: LocalSandboxOptions = {}): SandboxFactory {
	return {
		createSessionEnv: async () => createLocalSessionEnv(options),
	};
}
