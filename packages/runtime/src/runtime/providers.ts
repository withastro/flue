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

/**
 * Marker carried by every model synthesized from a dynamic model template.
 *
 * pi-ai's `Model` type has no "unknown metadata" state: `cost` must remain a
 * zero table (its `calculateCost` dereferences it unconditionally — omitting
 * it would crash every stream call), and `contextWindow`/`maxTokens` are `0`,
 * which `shouldCompact` already treats as "unknown". Use {@link isDynamicModel}
 * to tell "free" apart from "not yet known" when reading cost or budgeting.
 */
export const DYNAMIC_MODEL_MARKER = Symbol.for('flue.dynamicModelMarker');

/** True when `model` was synthesized from a dynamic model template. */
export function isDynamicModel(model: Model<Api>): boolean {
	return (model as Model<Api> & { [DYNAMIC_MODEL_MARKER]?: true })[DYNAMIC_MODEL_MARKER] === true;
}

/** One-time per process: the template escape hatch was used. */
let warnedAboutDynamicModelSynthesis = false;
function warnDynamicModelSynthesis(providerId: string, modelId: string): void {
	if (warnedAboutDynamicModelSynthesis) return;
	warnedAboutDynamicModelSynthesis = true;
	console.warn(
		`[flue] Model "${providerId}/${modelId}" is not in the provider's catalog and was ` +
			`synthesized from a dynamic model template. Its cost reads as $0 and it has no known ` +
			`context window — detect such models with isDynamicModel() from "@flue/runtime".`,
	);
}

/** Reset the one-time dynamic-model warning guard. Test-only. */
export function resetDynamicModelWarnForTests(): void {
	warnedAboutDynamicModelSynthesis = false;
}

/**
 * Zero-metadata Model literal for ids no catalog knows. Carries the
 * {@link DYNAMIC_MODEL_MARKER} so consumers can tell "free" (real zero-cost
 * models) from "unknown" (synthesized) metadata.
 */
function zeroMetadataModel(
	providerId: string,
	modelId: string,
	template: DynamicModelTemplate,
): Model<Api> {
	const model: Model<Api> = {
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
	(model as Model<Api> & { [DYNAMIC_MODEL_MARKER]: true })[DYNAMIC_MODEL_MARKER] = true;
	return model;
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

	const aliased = resolveVersionSeparatorAlias(providerId, modelId);
	if (aliased) return aliased;

	const template = (provider as ProviderWithDynamicModels)[DYNAMIC_MODEL_TEMPLATE];
	if (template) {
		warnDynamicModelSynthesis(providerId, modelId);
		return zeroMetadataModel(providerId, modelId, template);
	}

	throw new Error(
		`[flue] Unknown model ID "${modelId}" for provider "${providerId}". ` +
			`Declared model IDs: ${listModelIds(providerId)}.`,
	);
}

// ─── Version-separator aliases ──────────────────────────────────────────────

/**
 * Canonical form of a model ID for version-separator matching: a `-` or `.`
 * between two digits becomes `.`, so `claude-sonnet-4-6` and
 * `claude-sonnet-4.6` compare equal.
 */
function versionSeparatorKey(modelId: string): string {
	return modelId.replace(/(?<=\d)[-.](?=\d)/g, '.');
}

/** One warning per requested specifier: the alias fallback was used. */
const warnedVersionSeparatorAliases = new Set<string>();

/** Reset the version-separator alias warning guard. Test-only. */
export function resetVersionSeparatorAliasWarnForTests(): void {
	warnedVersionSeparatorAliases.clear();
}

/**
 * Resolve an undeclared model ID that differs from exactly one declared ID
 * only in its version separators (`-` vs `.` between digits).
 *
 * pi-ai catalogs occasionally rename IDs between these forms — pi 0.87 moved
 * the `cloudflare-ai-gateway` Claude models from `claude-sonnet-4-6` to
 * `claude-sonnet-4.6` — which would otherwise turn a dependency bump into a
 * hard `Unknown model ID` failure for every existing specifier. Ambiguous
 * matches resolve to nothing so the regular error still reports them.
 */
function resolveVersionSeparatorAlias(providerId: string, modelId: string): Model<Api> | undefined {
	if (!/\d[-.]\d/.test(modelId)) return undefined;
	const key = versionSeparatorKey(modelId);

	const candidates = models
		.getModels(providerId)
		.filter((model) => model.id !== modelId && versionSeparatorKey(model.id) === key);
	if (candidates.length !== 1) return undefined;

	const [model] = candidates as [Model<Api>];
	const requested = `${providerId}/${modelId}`;
	if (!warnedVersionSeparatorAliases.has(requested)) {
		warnedVersionSeparatorAliases.add(requested);
		console.warn(
			`[flue] Model "${requested}" is not in the provider's catalog; using ` +
				`"${providerId}/${model.id}", which differs only in version separators. ` +
				`Update the specifier to "${providerId}/${model.id}".`,
		);
	}
	return model;
}

function listModelIds(providerId: string): string {
	const ids = models.getModels(providerId).map((model) => model.id);
	if (ids.length === 0) return '(none)';
	const shown = ids.slice(0, 8).join(', ');
	return ids.length > 8 ? `${shown}, … (${ids.length} total)` : shown;
}
