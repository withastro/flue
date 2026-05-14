/**
 * `local()` — Sandbox factory binding directly to the host on the Node target.
 *
 * Thin `SandboxFactory` wrapper around `createLocalSessionEnv` from
 * `./local-env.ts`. The helper holds the real implementation (host fs +
 * `child_process.exec`, env allowlist resolution); this file just adapts
 * it to the public `init({ sandbox })` surface that connectors plug into.
 *
 * For full semantics — env allowlist, cwd defaulting, `exec` env layering —
 * see `LocalSessionEnvOptions` and `DEFAULT_LOCAL_ENV_ALLOWLIST` in
 * `./local-env.ts`.
 */
import type { SandboxFactory } from '../types.ts';
import {
	createLocalSessionEnv,
	type LocalSessionEnvOptions,
} from './local-env.ts';

export type LocalSandboxOptions = LocalSessionEnvOptions;

export function local(options: LocalSandboxOptions = {}): SandboxFactory {
	return {
		// The `cwd` parameter is the per-init hint from `init({ cwd })`. A
		// sandbox-level `local({ cwd })` always wins; otherwise we honor
		// the hint, falling through to `process.cwd()` inside the helper.
		// The framework also wraps the returned SessionEnv with
		// `createCwdSessionEnv(env, init.cwd)` (see client.ts), so when
		// neither is set the wrapper is the only thing scoping cwd.
		createSessionEnv: async ({ cwd }) =>
			createLocalSessionEnv({
				cwd: options.cwd ?? cwd,
				env: options.env,
			}),
	};
}
