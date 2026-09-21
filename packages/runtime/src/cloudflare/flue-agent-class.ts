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
 * - Submission execution runs on the Agents SDK `Tasks` capability the
 *   `Agent` base installs as `this.tasks`: `taskDefinitions` declares the one
 *   Flue conversation machine, whose phases delegate to the shared Cloudflare
 *   agent runtime. The SDK resolves the name against this field on every
 *   wake, so in-flight runs always find their handler.
 * - `onStart` / `onRequest` / `alarm` / `onError` delegate to the runtime and
 *   forward to an inherited implementation when the (possibly extended) base
 *   defines one.
 * - The module's `extend({ base, wrap })` export is resolved via
 *   `resolveCloudflareExtension`: `base` reshapes the superclass, `wrap`
 *   wraps the final class, and the wrapped class is what gets exported.
 */
import { type CloudflareAgentRuntime, FLUE_CONVERSATION_TASK } from './agent-coordinator.ts';
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
 * Task definitions an extension `base` declared as an instance field. Base
 * class fields are assigned before a subclass's own initializers run, so
 * reading the property at that point sees exactly the inherited value.
 */
function inheritedTaskDefinitions(instance: object): Record<string, unknown> {
	return (instance as { taskDefinitions?: Record<string, unknown> }).taskDefinitions ?? {};
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

		/**
		 * Flue's Task definitions, merged over any the extension `base`
		 * declared. The Agents SDK reads this field lazily and re-resolves it
		 * on every wake, which is what makes replay of an in-flight run
		 * correct by construction.
		 */
		readonly taskDefinitions: Record<string, unknown> = {
			...inheritedTaskDefinitions(this),
			[FLUE_CONVERSATION_TASK]: runtime.conversationDefinition(
				this as unknown as CloudflareAgentInstance,
			),
		};

		onStart(props?: Record<string, unknown>) {
			return runtime.onStart(this as unknown as CloudflareAgentInstance, () =>
				typeof super.onStart === 'function' ? super.onStart(props) : undefined,
			);
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

		/**
		 * The SDK reports terminal Task failures here (`onError(error)`; the
		 * `(connection, error)` overload is WebSocket-only and never Flue's).
		 * A failure the SDK recorded without running a handler — a deadline
		 * settled over a hung attempt, a definition missing after a deploy —
		 * leaves a submission row for the runtime to reconcile.
		 */
		async onError(...args: unknown[]) {
			try {
				if (typeof super.onError === 'function') await super.onError(...args);
			} finally {
				await runtime.onTaskError(
					this as unknown as CloudflareAgentInstance,
					args.length >= 2 ? args[1] : args[0],
				);
			}
		}
	}

	// The codegen named each class `Flue<PascalCase>Agent`; preserve that for
	// diagnostics and platform wrappers that read `constructor.name`.
	Object.defineProperty(FlueGeneratedAgent, 'name', { value: className, configurable: true });

	return resolved.wrap(FlueGeneratedAgent as ExtensionClass<any>);
}
