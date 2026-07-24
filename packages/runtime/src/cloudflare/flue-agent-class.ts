/**
 * Per-agent Durable Object class factory.
 *
 * The generated Cloudflare entry point collapses to
 * `export const FlueTriageAgent = createFlueAgentClass({...})` for each agent.
 *
 * Semantics:
 * - `runtime.prepare(...)` runs BEFORE `super(ctx, env)` so the coordinator's
 *   stores exist before the Agents SDK constructor can schedule work, then
 *   `runtime.attach(this, prepared)` binds the coordinator to the instance.
 * - `onStart` / `onRequest` / `onFiberRecovered` / the
 *   `__flueWakeAgentSubmissions` schedule target delegate to the shared
 *   Cloudflare agent runtime; `onStart`/`onFiberRecovered` forward to an
 *   inherited implementation when the (possibly extended) base defines one.
 * - The module's `extend({ base, wrap })` export is resolved via
 *   `resolveCloudflareExtension`: `base` reshapes the superclass, `wrap`
 *   wraps the final class, and the wrapped class is what gets exported.
 */
import type { CloudflareAgentRuntime } from './agent-coordinator.ts';
import { type ExtensionClass, resolveCloudflareExtension } from './extension.ts';

type CloudflareAgentInstance = Parameters<CloudflareAgentRuntime['attach']>[0];
type CloudflareAgentStorage = Parameters<CloudflareAgentRuntime['prepare']>[0]['storage'];

interface DurableObjectStateLike {
	readonly storage: CloudflareAgentStorage;
}

export interface CreateFlueAgentClassOptions {
	/**
	 * The Cloudflare Agents SDK `Agent` class (the generated entry imports it
	 * from the user's `agents` package; `@flue/runtime` does not depend on it).
	 */
	readonly AgentBase: ExtensionClass<any>;
	/** The shared per-Worker Cloudflare agent runtime (`createCloudflareAgentRuntime`). */
	readonly runtime: CloudflareAgentRuntime;
	/** Generated Durable Object class name, e.g. `FlueTriageAgent`. */
	readonly className: string;
	/** The agent's identity (file basename), e.g. `triage`. */
	readonly agentName: string;
	/**
	 * The agent module's `cloudflare` named export, if any — must be created
	 * with `extend({ base, wrap })` from `@flue/runtime/cloudflare`.
	 */
	readonly extension?: unknown;
}

/**
 * Build the final (possibly extension-wrapped) Durable Object class for one
 * agent module.
 */
export function createFlueAgentClass(options: CreateFlueAgentClassOptions): ExtensionClass<any> {
	const { AgentBase, runtime, className, agentName, extension } = options;
	const resolved = resolveCloudflareExtension(
		extension === undefined ? {} : { cloudflare: extension },
		agentName,
		'Agent',
	);
	const Base = resolved.base(AgentBase);

	class FlueGeneratedAgent extends Base {
		constructor(ctx: DurableObjectStateLike, env: unknown) {
			// prepare() must run before super(): the Agents SDK constructor can
			// synchronously schedule callbacks that reach the coordinator's
			// stores, so they are created from ctx.storage first (statements
			// before super() are legal while `this` stays untouched).
			const prepared = runtime.prepare({ storage: ctx.storage, className, agentName });
			super(ctx, env);
			runtime.attach(this as unknown as CloudflareAgentInstance, prepared);
		}

		onStart(props?: Record<string, unknown>) {
			return runtime.onStart(this as unknown as CloudflareAgentInstance, () =>
				typeof super.onStart === 'function' ? super.onStart(props) : undefined,
			);
		}

		/**
		 * Durable schedule target that owns submission execution: armed at zero
		 * delay by admission/abort/recovery boundaries and at 30s as the
		 * reconciliation backstop. Dispatched from the Durable Object's alarm
		 * invocation, it drains — starts AND awaits — every runnable attempt,
		 * so the alarm invocation owns the agent's work end to end.
		 */
		__flueWakeAgentSubmissions() {
			return runtime.drainSubmissions(this as unknown as CloudflareAgentInstance);
		}

		onRequest(request: Request) {
			return runtime.onRequest(this as unknown as CloudflareAgentInstance, request);
		}

		/**
		 * The Agents SDK alarm handler dispatches `schedule`/`scheduleEvery`/
		 * `queue` callbacks to methods on this class — including
		 * extension-authored ones — so it is a real Durable Object entry
		 * boundary and must establish the instance context (#437).
		 */
		alarm(...args: unknown[]) {
			return runtime.onAlarm(this as unknown as CloudflareAgentInstance, () =>
				typeof super.alarm === 'function' ? super.alarm(...args) : undefined,
			);
		}

		onFiberRecovered(ctx: { readonly name?: string; readonly snapshot?: Record<string, unknown> }) {
			return runtime.onFiberRecovered(this as unknown as CloudflareAgentInstance, ctx, () =>
				typeof super.onFiberRecovered === 'function' ? super.onFiberRecovered(ctx) : undefined,
			);
		}
	}

	// The codegen named each class `Flue<PascalCase>Agent`; preserve that for
	// diagnostics and platform wrappers that read `constructor.name`.
	Object.defineProperty(FlueGeneratedAgent, 'name', { value: className, configurable: true });

	return resolved.wrap(FlueGeneratedAgent as ExtensionClass<any>);
}
