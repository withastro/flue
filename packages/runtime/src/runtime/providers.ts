/** The runtime's pi-ai `Models` instance, consumed by `resolveModel` and Session. */

import {
	type Api,
	createModels,
	type Model,
	type MutableModels,
	type Provider,
} from '@earendil-works/pi-ai';

// ─── Models instance ────────────────────────────────────────────────────────

/**
 * Module-scoped pi-ai Models instance, populated at module init by `app.ts`
 * and generated server entries. Provider auth (API keys, OAuth) resolves
 * through each provider's own `auth` declaration — env vars on Node, and on
 * Cloudflare via `nodejs_compat`'s `process.env`.
 */
let models: MutableModels = createModels();

/**
 * Register a pi-ai provider with the runtime. Accepts any `Provider` —
 * a built-in factory (`anthropicProvider()` from
 * `@earendil-works/pi-ai/providers/anthropic`), `createProvider(...)` for
 * custom endpoints, or `fauxProvider().provider` in tests.
 *
 * Each call REPLACES any previous provider with the same `id`; calls do not
 * accumulate. On Cloudflare, registering a `cloudflare` provider in `app.ts`
 * takes precedence over the generated Workers AI binding default.
 */
export function setProvider(provider: Provider): void {
	models.setProvider(provider);
}

/** Whether a provider ID has already been registered. */
export function hasProvider(providerId: string): boolean {
	return models.getProvider(providerId) !== undefined;
}

/** The runtime's Models instance. Internal: Session stream/completion calls. */
export function getRuntimeModels(): MutableModels {
	return models;
}

/** Replace the Models instance wholesale. Test-only. */
export function resetModelsForTests(): void {
	models = createModels();
}

/**
 * Register a built-in provider from its
 * `@earendil-works/pi-ai/providers/<id>` module namespace. Generated entries
 * call this: picking the factory out of the namespace keeps pi's exact export
 * names (`anthropicProvider`, `azureOpenAIResponsesProvider`, …) out of
 * generated code, so pi's naming can't drift out from under it. Skips IDs
 * that are already registered so `app.ts` overrides win regardless of module
 * evaluation order.
 */
export function registerBuiltinProviderModule(id: string, moduleNamespace: object): void {
	if (hasProvider(id)) return;
	const factories = Object.entries(moduleNamespace).filter(
		([name, value]) => name.endsWith('Provider') && typeof value === 'function',
	);
	const factory = factories.length === 1 ? factories[0] : undefined;
	if (!factory) {
		const found = factories.map(([name]) => name).join(', ');
		throw new Error(
			`[flue] "@earendil-works/pi-ai/providers/${id}" is not a single-provider module: ` +
				`expected exactly one exported \`*Provider\` factory, found ${factories.length === 0 ? 'none' : found}. ` +
				`Check the \`providers\` entry "${id}" in your flue() config.`,
		);
	}
	const provider = (factory[1] as () => Provider)();
	if (provider?.id !== id) {
		throw new Error(
			`[flue] "@earendil-works/pi-ai/providers/${id}" registered provider ID ` +
				`"${provider?.id}" instead of "${id}". Check the \`providers\` entry in your flue() config.`,
		);
	}
	setProvider(provider);
}

// ─── Telemetry naming ───────────────────────────────────────────────────────

/**
 * OpenTelemetry GenAI system name for a provider ID, per the semconv
 * `gen_ai.system` well-known values. Unlisted IDs pass through unchanged.
 */
export function providerTelemetryName(providerId: string): string {
	return (
		{
			'amazon-bedrock': 'aws.bedrock',
			anthropic: 'anthropic',
			'azure-openai-responses': 'azure.ai.openai',
			deepseek: 'deepseek',
			google: 'gcp.gemini',
			'google-vertex': 'gcp.vertex_ai',
			groq: 'groq',
			mistral: 'mistral_ai',
			moonshotai: 'moonshot_ai',
			'moonshotai-cn': 'moonshot_ai',
			openai: 'openai',
			xai: 'x_ai',
		}[providerId] ?? providerId
	);
}

// ─── Dynamic model IDs ──────────────────────────────────────────────────────

/**
 * Providers that serve model IDs beyond their declared `models` list opt in
 * by carrying this template. `resolveModel` synthesizes a zero-metadata Model
 * from it when the ID isn't declared — Workers AI regularly ships model IDs
 * pi-ai's catalog doesn't know yet, and the binding accepts arbitrary IDs.
 */
export const DYNAMIC_MODEL_TEMPLATE = Symbol.for('flue.dynamicModelTemplate');

interface DynamicModelTemplate {
	api: Api;
	baseUrl: string;
}

type ProviderWithDynamicModels = Provider & {
	[DYNAMIC_MODEL_TEMPLATE]?: DynamicModelTemplate;
};

/** Zero-metadata Model literal for ids no catalog knows. */
function zeroMetadataModel(
	providerId: string,
	modelId: string,
	template: DynamicModelTemplate,
): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		api: template.api,
		provider: providerId,
		baseUrl: template.baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// `shouldCompact` treats `contextWindow <= 0` as unknown.
		contextWindow: 0,
		maxTokens: 0,
	};
}

// ─── Model resolution ───────────────────────────────────────────────────────

/**
 * Resolve a `provider-id/model-id` model specifier to a pi-ai Model against
 * the runtime's registered providers.
 */
export function resolveModel(model: string): Model<Api> {
	const modelSpecifier = model;

	const slash = modelSpecifier.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model specifier "${modelSpecifier}". ` +
				`Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const providerId = modelSpecifier.slice(0, slash);
	const modelId = modelSpecifier.slice(slash + 1);

	const provider = models.getProvider(providerId);
	if (!provider) {
		const registered = models
			.getProviders()
			.map((registered) => registered.id)
			.sort();
		throw new Error(
			`[flue] Unknown provider "${providerId}" in model specifier "${modelSpecifier}". ` +
				(registered.length > 0
					? `Registered providers: ${registered.join(', ')}. `
					: 'No providers are registered. ') +
				`Include built-in providers via the \`providers\` option of the flue() Vite plugin, ` +
				`or register one with setProvider() in app.ts.`,
		);
	}
	if (modelId === '') {
		throw new Error(
			`[flue] Invalid model specifier "${modelSpecifier}". ` +
				`Provider "${providerId}" is registered, but no model ID was given. ` +
				`Use "${providerId}/<model-id>".`,
		);
	}

	const resolved = models.getModel(providerId, modelId);
	if (resolved) return resolved;

	const template = (provider as ProviderWithDynamicModels)[DYNAMIC_MODEL_TEMPLATE];
	if (template) return zeroMetadataModel(providerId, modelId, template);

	throw new Error(
		`[flue] Unknown model ID "${modelId}" for provider "${providerId}". ` +
			`Declared model IDs: ${listModelIds(providerId)}.`,
	);
}

function listModelIds(providerId: string): string {
	const ids = models.getModels(providerId).map((model) => model.id);
	if (ids.length === 0) return '(none)';
	const shown = ids.slice(0, 8).join(', ');
	return ids.length > 8 ? `${shown}, … (${ids.length} total)` : shown;
}
