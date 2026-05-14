/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists solely so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs.
 *
 * User agent code should never import from here.
 */
import { type Api, getModel, type KnownProvider, type Model } from '@mariozechner/pi-ai';
import {
	getProviderConfiguration,
	hasRegisteredProvider,
	resolveRegisteredModel,
} from './runtime/providers.ts';
import type { ModelConfig, ProviderSettings } from './types.ts';

export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext } from './client.ts';
// `parseFrontmatterFile` is used by the CLI's build pipeline (which lives in
// `@flue/cli/src/lib/build.ts`) to extract role frontmatter at build time. It
// is otherwise an internal helper of the runtime — exposed here, not on the
// public root barrel, because it's tooling-facing.
export { parseFrontmatterFile } from './context.ts';
// `FlueRegistry` (Durable Object class) and `createCloudflareRunRegistry`
// (registry client) live in the `@flue/runtime/cloudflare` subpath because
// they pull in `cloudflare:workers`, a virtual module Node can't resolve.
// The generated CF entry imports them from there directly.
export { createDurableRunStore } from './cloudflare/run-store.ts';
export { InMemoryRunRegistry } from './node/run-registry.ts';
export { InMemoryRunStore } from './node/run-store.ts';
export type { FlueRuntime } from './runtime/flue-app.ts';
export { configureFlueRuntime, createDefaultFlueApp } from './runtime/flue-app.ts';
export type {
	AgentHandler,
	CreateContextFn,
	HandleAgentOptions,
	RunHandlerFn,
	StartWebhookFn,
} from './runtime/handle-agent.ts';
// Runtime modules consumed by the generated server entries.
//
//   - `handleAgentRequest` is the per-agent dispatcher (webhook / SSE /
//     sync). Used directly by the Cloudflare entry's `dispatchAgent`
//     wrapper to layer in DO-specific keepalive / fiber handling. The
//     Node target reaches the same dispatcher through `flue()`.
//
//   - `configureFlueRuntime` seeds the module-scoped config that
//     `flue()` reads at request time. Called once per generated entry,
//     before the listener (Node) or `default.fetch` (Cloudflare) takes
//     traffic.
//
//   - `createDefaultFlueApp` is the no-`app.ts` fallback. Lives in
//     @flue/runtime so the generated entry doesn't have to import `hono` (which
//     keeps user projects from needing it as a direct dep when they
//     don't author their own `app.ts`).
//
// The user-facing `flue()` itself is re-exported from `@flue/runtime/app`, not here.
export { handleAgentRequest } from './runtime/handle-agent.ts';
export type { HandleRunRouteOptions } from './runtime/handle-run-routes.ts';
export { handleRunRouteRequest } from './runtime/handle-run-routes.ts';
export type {
	InstancePointer,
	ListInstancesOpts,
	ListInstancesResponse,
	ListRunsOpts,
	ListRunsResponse,
	RecordRunEndInput,
	RecordRunStartInput,
	RunPointer,
	RunRegistry,
} from './runtime/run-registry.ts';
export type { RunRecord, RunStatus, RunStore } from './runtime/run-store.ts';
export type { RunSubscriberListener, RunSubscriberRegistry } from './runtime/run-subscribers.ts';
export { createRunSubscriberRegistry } from './runtime/run-subscribers.ts';
export { bashFactoryToSessionEnv } from './sandbox.ts';
export { hasRegisteredProvider } from './runtime/providers.ts';
export { InMemorySessionStore } from './session.ts';

/**
 * Resolve `provider/model-id` to a pi-ai Model. Registered URL prefixes win
 * over pi-ai's catalog; configureProvider settings patch the resolved Model.
 */
export function resolveModel(model: ModelConfig | undefined): Model<Api> | undefined {
	if (model === false || model === undefined) return undefined;

	const modelString = model;

	const slash = modelString.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Use the "provider/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const provider = modelString.slice(0, slash);
	const modelId = modelString.slice(slash + 1);

	// Registered prefixes win over pi-ai's catalog.
	const built = resolveRegisteredModel(provider, modelId);
	if (built) {
		if (modelId === '') {
			throw new Error(
				`[flue] Invalid model "${modelString}". ` +
					`The "${provider}/" prefix is registered via registerProvider(), but no model id ` +
					`was given. Use "${provider}/<model-id>".`,
			);
		}
		// Overrides are keyed by the resolved provider slug.
		return applyProviderSettings(built, getProviderConfiguration(built.provider));
	}

	// `getModel` is typed for literal model ids; runtime strings are checked by
	// the null return below.
	const resolved = getModel(provider as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model "${modelString}". ` +
				`Provider "${provider}" / model id "${modelId}" ` +
				`is not registered with @mariozechner/pi-ai or via registerProvider().`,
		);
	}
	return applyProviderSettings(resolved, getProviderConfiguration(provider));
}

function applyProviderSettings<TApi extends Api>(
	model: Model<TApi>,
	providerSettings: ProviderSettings | undefined,
): Model<TApi> {
	if (!providerSettings) return model;

	const hasBaseUrl = providerSettings.baseUrl !== undefined;
	const hasHeaders = providerSettings.headers !== undefined;
	if (!hasBaseUrl && !hasHeaders) return model;

	return {
		...model,
		baseUrl: providerSettings.baseUrl ?? model.baseUrl,
		headers: hasHeaders ? { ...(model.headers ?? {}), ...providerSettings.headers } : model.headers,
	};
}
