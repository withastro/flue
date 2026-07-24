import type { SandboxFactory } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Attach the environment this agent instance runs in: the sandbox adapter's
 * `createSessionEnv()` builds the filesystem/exec surface at initialization
 * (once per initialized harness — adapters key durable resources on the
 * instance id; see {@link SandboxFactory.createSessionEnv}), and its
 * `tools()` — when present — REPLACES the framework's default model-facing
 * tool set (a codemode sandbox ships a `code` tool instead of bash, say).
 * Re-renders never rebuild the environment.
 *
 * Takes the `SandboxFactory` value directly — the factory itself is already
 * lazy (constructing it is cheap; the expensive `createSessionEnv()` call
 * happens once, at initialization):
 *
 * ```ts
 * function IssueTriage() {
 *   useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
 *   // ...
 * }
 * ```
 *
 * Callable from the agent body or a custom hook — but at most
 * once per render (an agent has one environment). Without it, the agent has
 * NO environment: the built-in shell and filesystem tools aren't added, and
 * sandbox-backed operations throw. There is no default sandbox.
 *
 * The call may be conditional. Presence is read at initialization and again
 * at every turn boundary: when it flips (a tool flipping `usePersistentState`
 * mid-run, say), the runtime swaps the environment before the next model
 * call — attach resolves the declared factory, detach removes the
 * environment and its tools — and announces the change to the model as one
 * `environment` signal restating the full current state. Only PRESENCE is
 * observable (factories are fresh objects every render), so replacing one
 * sandbox with another while staying attached takes effect at the next
 * submission's initialization instead. A condition derived from persistent
 * state replays durably, so every later submission re-attaches the same
 * declaration, and adapters keyed on the instance id resolve back to the
 * same durable workspace.
 *
 * `options.cwd` scopes the agent's working directory inside the initialized
 * environment. Like the factory, it is read once when a submission starts.
 */
export interface UseSandboxOptions {
	/** Working directory inside the initialized environment. */
	cwd?: string;
}

export function useSandbox(sandbox: SandboxFactory, options: UseSandboxOptions = {}): void {
	const frame = requireRenderFrame('useSandbox');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useSandbox() is not available in a subagent render. Delegates share the parent agent's environment (scope work with the task call's cwd instead).",
		);
	}
	if (
		!sandbox ||
		typeof sandbox !== 'object' ||
		typeof (sandbox as Partial<SandboxFactory>).createSessionEnv !== 'function'
	) {
		throw new Error(
			'[flue] useSandbox() requires a sandbox factory (an object with createSessionEnv()), like the value local() returns.',
		);
	}
	if (sandbox.tools !== undefined && typeof sandbox.tools !== 'function') {
		throw new Error('[flue] useSandbox() sandbox `tools` must be a function when present.');
	}
	if (frame.sandbox !== undefined) {
		throw new Error(
			'[flue] useSandbox() was called twice in one render. An agent has one environment — attach it once, in the agent body or a single custom hook.',
		);
	}
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[flue] useSandbox() options must be an object.');
	}
	for (const key of Object.keys(options)) {
		if (key !== 'cwd') {
			throw new Error(`[flue] useSandbox() options received unknown field "${key}".`);
		}
	}
	if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0)) {
		throw new Error('[flue] useSandbox() options.cwd must be a non-empty string.');
	}
	frame.sandbox = sandbox;
	if (options.cwd !== undefined) frame.cwd = options.cwd;
}
