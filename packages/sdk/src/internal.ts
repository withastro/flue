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
import { getModel, type Api, type KnownProvider, type Model } from '@mariozechner/pi-ai';
import {
	CLOUDFLARE_MODEL_PREFIX,
	createCloudflareAIBindingModel,
} from './cloudflare-model.ts';
import type { ModelConfig, ProviderSettings, ProvidersConfig } from './types.ts';

export { createFlueContext } from './client.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { InMemorySessionStore } from './session.ts';
export { bashFactoryToSessionEnv } from './sandbox.ts';

// Error framework. Re-exported here for the build-plugin templates. Trimmed
// to only the names the templates actually import — anything thrown
// transitively by the helpers (e.g. UnsupportedMediaTypeError thrown inside
// parseJsonBody) is bundled via static imports inside error-utils.ts and
// doesn't need to appear on this surface. If a future template needs more,
// add it here at that time.
export { parseJsonBody, toHttpResponse, toSseData, validateAgentRequest } from './error-utils.ts';
export {
	AgentNotFoundError,
	InvalidRequestError,
	MethodNotAllowedError,
	RouteNotFoundError,
} from './errors.ts';

/**
 * Resolve a `provider/model-id` string into a pi-ai `Model` object.
 * Lives here (rather than in the generated entry point) so that user
 * projects don't have to declare `@mariozechner/pi-ai` as a direct
 * dependency — wrangler's bundler resolves bare specifiers from the entry
 * file's location, which on pnpm-isolated installs doesn't see Flue's
 * transitive deps. Centralizing the resolver here keeps `_entry.ts`
 * dependency-free apart from `@flue/sdk/*`.
 */
export function resolveModel(
	model: ModelConfig | undefined,
	providers?: ProvidersConfig,
): Model<Api> | undefined {
	if (model === false || model === undefined) return undefined;

	const modelString = model;

	// Routes through the Workers AI binding; the provider is only registered
	// on the Cloudflare target, so node-target use fails at dispatch time with
	// pi-ai's "no API provider registered" error.
	if (modelString.startsWith(CLOUDFLARE_MODEL_PREFIX)) {
		const workersAiModelId = modelString.slice(CLOUDFLARE_MODEL_PREFIX.length);
		if (!workersAiModelId) {
			throw new Error(
				`[flue] Invalid model "${modelString}". ` +
					`Use "cloudflare/<workers-ai-model-id>" (e.g. "cloudflare/@cf/moonshotai/kimi-k2.6").`,
			);
		}
		// `providers.cloudflare` settings are not applied: the binding owns
		// transport and ignores baseUrl/headers/apiKey. For gateway-based
		// observability, use pi-ai's `cloudflare-ai-gateway` provider.
		return createCloudflareAIBindingModel(workersAiModelId);
	}

	const slash = modelString.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Use the "provider/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const provider = modelString.slice(0, slash);
	const modelId = modelString.slice(slash + 1);
	// `getModel` is overloaded on literal provider/modelId; we cast through
	// runtime strings and rely on the null-return check below for unknowns.
	const resolved = getModel(provider as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model "${modelString}". ` +
				`Provider "${provider}" / model id "${modelId}" ` +
				`is not registered with @mariozechner/pi-ai.`,
		);
	}
	return applyProviderSettings(resolved, providers?.[provider]);
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
