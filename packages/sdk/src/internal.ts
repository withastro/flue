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
import type { ModelConfig, ModelFactory, ProviderSettings, ProvidersConfig } from './types.ts';

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
 *
 * Lives here (rather than in the generated entry point) so user projects
 * don't have to declare `@mariozechner/pi-ai` as a direct dependency.
 * Wrangler's bundler resolves bare specifiers from the entry file's
 * location, which on pnpm-isolated installs doesn't see Flue's transitive
 * deps. Centralising resolution keeps `_entry.ts` dependency-free apart
 * from `@flue/sdk/*`.
 *
 * Resolution order:
 *   1. User-defined prefixes from `flue.config.ts`'s `models` map (longest
 *      match wins). This lets users opt into local endpoints (Ollama, vLLM,
 *      LM Studio, …) without changing call sites.
 *   2. Built-in `cloudflare/` branch — Workers AI binding-backed models.
 *   3. The pi-ai catalog (`anthropic/...`, `openai/...`, …).
 *
 * Generated server entries inject `userModels` at boot; not part of the
 * public API.
 */
export function resolveModel(
	model: ModelConfig | undefined,
	providers?: ProvidersConfig,
	userModels?: Record<string, ModelFactory>,
): Model<Api> | undefined {
	if (model === false || model === undefined) return undefined;

	const userResolved = resolveUserModel(model, providers, userModels);
	if (userResolved) return userResolved;

	if (model.startsWith(CLOUDFLARE_MODEL_PREFIX)) {
		return resolveCloudflareModel(model);
	}

	return resolveCatalogModel(model, providers);
}

/**
 * Match `modelString` against the user-defined `models` map. Returns
 * `undefined` when no prefix matches, so the caller falls through to the
 * built-in branches; throws when a matched factory misbehaves so the user
 * sees a `[flue]`-prefixed diagnostic instead of a raw stack.
 */
function resolveUserModel(
	modelString: string,
	providers: ProvidersConfig | undefined,
	userModels: Record<string, ModelFactory> | undefined,
): Model<Api> | undefined {
	if (!userModels) return undefined;
	const matched = findLongestPrefixMatch(modelString, userModels);
	if (!matched) return undefined;

	const { prefix, factory } = matched;
	const suffix = modelString.slice(prefix.length);
	if (!suffix) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Prefix "${prefix}" requires a suffix (e.g. "${prefix}llama3.1:8b").`,
		);
	}

	const built = invokeUserFactory(prefix, factory, suffix, modelString);
	return applyProviderSettings(built, providers?.[built.provider]);
}

function invokeUserFactory(
	prefix: string,
	factory: ModelFactory,
	suffix: string,
	modelString: string,
): Model<Api> {
	let result: Model<Api>;
	try {
		result = factory(suffix);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`[flue] models[${JSON.stringify(prefix)}] factory threw while resolving ` +
				`"${modelString}": ${message}`,
		);
	}
	if (!result || typeof result !== 'object' || typeof result.id !== 'string') {
		throw new Error(
			`[flue] models[${JSON.stringify(prefix)}] factory must return a pi-ai Model ` +
				`(got ${typeof result}). Use \`defineOpenAICompletionsModel\` to build one.`,
		);
	}
	return result;
}

/**
 * Build a Workers AI binding-backed Model from a `cloudflare/<id>` string.
 * `providers.cloudflare` is intentionally not applied: the binding owns
 * transport and ignores baseUrl/headers/apiKey. For gateway-based
 * observability, use pi-ai's `cloudflare-ai-gateway` provider directly.
 */
function resolveCloudflareModel(modelString: string): Model<Api> {
	const workersAiModelId = modelString.slice(CLOUDFLARE_MODEL_PREFIX.length);
	if (!workersAiModelId) {
		throw new Error(
			`[flue] Invalid model "${modelString}". ` +
				`Use "cloudflare/<workers-ai-model-id>" (e.g. "cloudflare/@cf/moonshotai/kimi-k2.6").`,
		);
	}
	return createCloudflareAIBindingModel(workersAiModelId);
}

/**
 * Look up `provider/model-id` in pi-ai's static catalog, applying any
 * matching `providers` override.
 */
function resolveCatalogModel(
	modelString: string,
	providers: ProvidersConfig | undefined,
): Model<Api> {
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
				`is not registered with @mariozechner/pi-ai. ` +
				`To use a custom or local OpenAI-compatible endpoint, register a ` +
				`prefix in flue.config.ts via \`models: { '${provider}/': ... }\`.`,
		);
	}
	return applyProviderSettings(resolved, providers?.[provider]);
}

function findLongestPrefixMatch(
	modelString: string,
	userModels: Record<string, ModelFactory>,
): { prefix: string; factory: ModelFactory } | undefined {
	let best: { prefix: string; factory: ModelFactory } | undefined;
	for (const [prefix, factory] of Object.entries(userModels)) {
		if (modelString.startsWith(prefix)) {
			if (!best || prefix.length > best.prefix.length) {
				best = { prefix, factory };
			}
		}
	}
	return best;
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
