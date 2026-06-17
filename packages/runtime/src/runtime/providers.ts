/** Runtime provider registries consumed by `resolveModel` and Session. */

import {
	type Api,
	getModel,
	getModels,
	type KnownProvider,
	type Model,
	registerApiProvider as piRegisterApiProvider,
} from '@earendil-works/pi-ai';
import type { CloudflareGatewayOptions } from '../cloudflare/gateway.ts';
import { CLOUDFLARE_AI_BINDING_API } from '../cloudflare-model.ts';
import { ProviderRegistrationError } from '../errors.ts';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Minimal Workers AI binding shape. Kept structural so `@flue/runtime` stays
 * importable on Node.
 */
export interface CloudflareAIBinding {
	run(
		modelId: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<Response | Record<string, unknown>>;
}

/**
 * Provider declarations keyed by provider ID. HTTP providers carry endpoint
 * settings; Workers AI binding providers carry the captured binding object.
 */
export type ProviderRegistration = HttpProviderRegistration | CloudflareAIBindingRegistration;

/** Register an HTTP-backed provider ID with {@link registerProvider}. */
export interface HttpProviderRegistration {
	/**
	 * Wire protocol used for requests. Required for provider IDs that neither
	 * Pi's catalog nor Flue's built-in provider defaults know; otherwise
	 * defaults to the built-in protocol.
	 */
	api?: Api;
	/**
	 * Endpoint root, e.g. `'https://api.anthropic.com/v1'`. Required for
	 * provider IDs that neither Pi's catalog nor Flue's built-in provider
	 * defaults know; otherwise defaults to the built-in endpoint.
	 */
	baseUrl?: string;
	/**
	 * Optional API key. Propagated to pi-ai via the harness's per-call
	 * `getApiKey(providerId)` callback. Falls back to whatever pi-ai's normal
	 * env-var lookup produces if unset.
	 */
	apiKey?: string;
	/**
	 * Headers sent on every outgoing request. Merged per key over the catalog
	 * model's headers when the provider ID hydrates from the catalog; this
	 * registration's values win on conflict.
	 */
	headers?: Record<string, string>;
	/**
	 * Default `contextWindow` (in tokens) for every model resolved through
	 * this registration. Overridden per-model via {@link models}. Unset falls
	 * back to the catalog value for catalog models, then to `0`, which the
	 * runtime treats as "unknown".
	 */
	contextWindow?: number;
	/**
	 * Default `maxTokens` for every model resolved through this registration.
	 * Overridden per-model via {@link models}. Unset falls back to the catalog
	 * value for catalog models, then to `0`.
	 */
	maxTokens?: number;
	/** Per-model overrides for {@link contextWindow} and {@link maxTokens}, keyed by model ID. */
	models?: Record<string, { contextWindow?: number; maxTokens?: number }>;
	/**
	 * Sends `store: true` for OpenAI Responses API providers. Only enable when
	 * you need OpenAI-hosted item persistence and accept its retention policy.
	 */
	storeResponses?: boolean;
}

/** Register a Workers AI binding-backed provider ID with {@link registerProvider}. */
export interface CloudflareAIBindingRegistration {
	api: typeof CLOUDFLARE_AI_BINDING_API;
	/** The captured `env.AI` reference. Read at registration time. */
	binding: CloudflareAIBinding;
	/**
	 * AI Gateway options forwarded to every `env.AI.run(...)` call routed
	 * through this registration.
	 *
	 * - Omitted: routes through Cloudflare's default AI Gateway, which the
	 *   binding spins up on demand for the account.
	 * - Options object: replaces the default. Specify `id` plus any other
	 *   knobs (cache, metadata, logging).
	 * - `false`: opts out — no gateway is passed to `ai.run`.
	 *
	 * See https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/.
	 */
	gateway?: CloudflareGatewayOptions | false;
}

/**
 * pi-ai's open-ended `Api` type prevents direct discriminator narrowing.
 */
function isCloudflareBindingRegistration(
	def: ProviderRegistration,
): def is CloudflareAIBindingRegistration {
	return def.api === CLOUDFLARE_AI_BINDING_API;
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Provider registry populated at module init by `app.ts` and generated
 * server entries.
 */
const providersById = new Map<string, ProviderRegistration>();

type BuiltInHttpProviderDefaults = Pick<HttpProviderRegistration, 'api' | 'baseUrl'> & {
	api: Api;
	baseUrl: string;
	apiKeyEnvVar?: string;
};

const builtInHttpProvidersById = new Map<string, BuiltInHttpProviderDefaults>([
	[
		'nebius',
		{
			api: 'openai-completions',
			baseUrl: 'https://api.tokenfactory.nebius.com/v1',
			apiKeyEnvVar: 'NEBIUS_API_KEY',
		},
	],
]);

function getBuiltInHttpProviderDefaults(
	providerId: string,
): BuiltInHttpProviderDefaults | undefined {
	return builtInHttpProvidersById.get(providerId);
}

function getEnvVar(name: string): string | undefined {
	if (typeof process === 'undefined' || !process.env) return undefined;
	const value = process.env[name];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Register a model provider keyed by the provider ID used in model specifiers.
 *
 * When the provider ID is a catalog provider, models resolve from the catalog
 * — preserving metadata such as cost, context window, and wire protocol —
 * with this call's options layered on top. That makes transport overrides
 * one call:
 *
 * ```ts
 * registerProvider('anthropic', {
 *   baseUrl: 'https://gateway.example.com/anthropic',
 *   apiKey: process.env.GATEWAY_KEY,
 * });
 * ```
 *
 * Provider IDs that neither Pi's catalog nor Flue's built-in provider defaults
 * know are registered from scratch and must supply `api` and `baseUrl`.
 *
 * Each call REPLACES the provider ID's previous registration; calls do not
 * accumulate. The effective settings are always the built-in defaults (when
 * the ID is known through Pi's catalog or Flue's provider defaults) plus the
 * latest call's options. On Cloudflare, registering the `cloudflare` provider
 * ID in `app.ts` takes precedence over the generated Workers AI binding
 * default.
 */
export function registerProvider(providerId: string, registration: ProviderRegistration): void {
	const builtInDefaults = isCloudflareBindingRegistration(registration)
		? undefined
		: getBuiltInHttpProviderDefaults(providerId);
	if (
		!isCloudflareBindingRegistration(registration) &&
		((registration.api ?? builtInDefaults?.api) === undefined ||
			(registration.baseUrl ?? builtInDefaults?.baseUrl) === undefined) &&
		getModels(providerId as KnownProvider).length === 0
	) {
		throw new ProviderRegistrationError({ providerId });
	}
	providersById.set(providerId, registration);
}

export function resetProvidersForTests(): void {
	providersById.clear();
}

/** Whether a provider ID has already been registered. */
export function hasRegisteredProvider(providerId: string): boolean {
	return providersById.has(providerId);
}

/** Look up an API key registered for a provider ID or supplied by a Flue built-in provider. */
export function getRegisteredApiKey(providerId: string): string | undefined {
	const registration = providersById.get(providerId);
	if (registration && isCloudflareBindingRegistration(registration)) return undefined;
	if (registration?.apiKey) return registration.apiKey;

	const builtInDefaults = getBuiltInHttpProviderDefaults(providerId);
	return builtInDefaults?.apiKeyEnvVar ? getEnvVar(builtInDefaults.apiKeyEnvVar) : undefined;
}

/** Whether a registered provider opted into OpenAI-hosted response storage. */
export function getRegisteredStoreResponses(providerId: string): boolean {
	const registration = providersById.get(providerId);
	if (!registration || isCloudflareBindingRegistration(registration)) return false;
	return registration.storeResponses === true;
}

/**
 * Re-export of pi-ai's `registerApiProvider`. Use to register a brand-new
 * wire-protocol handler for an `api` slug pi-ai doesn't ship. Then call
 * {@link registerProvider} to associate a provider ID with that api.
 *
 * ```ts
 * registerApiProvider({ api: 'my-novel-api', stream, streamSimple });
 * registerProvider('thing', { api: 'my-novel-api', baseUrl: '...', apiKey: '...' });
 * ```
 *
 * pi-ai's registry is also module-scoped and last-write-wins. Calling
 * `registerApiProvider` repeatedly with the same `api` string overwrites,
 * so generated code can register on every isolate boot without dedupe
 * bookkeeping.
 */
export const registerApiProvider = piRegisterApiProvider;

// ─── Model binding extension ────────────────────────────────────────────────

/**
 * Resolved Model with the captured Workers AI binding (and optional AI
 * Gateway options) attached as non-pi-ai extension fields. Flows from the
 * registration through the resolved Model to the Workers AI stream
 * function without going through AsyncLocalStorage.
 */
type ModelWithBinding<TApi extends Api> = Model<TApi> & {
	binding: CloudflareAIBinding;
	gateway?: CloudflareGatewayOptions;
};

/** Attach a Workers AI binding (and optional gateway options) to a Model literal. */
function attachModelBinding<TApi extends Api>(
	model: Model<TApi>,
	binding: CloudflareAIBinding,
	gateway?: CloudflareGatewayOptions,
): ModelWithBinding<TApi> {
	return { ...model, binding, gateway } as ModelWithBinding<TApi>;
}

/**
 * Read a Workers AI binding off a resolved Model, or `undefined` if no
 * usable binding is attached.
 */
export function getModelBinding<TApi extends Api>(
	model: Model<TApi>,
): CloudflareAIBinding | undefined {
	const candidate = (model as Model<TApi> & { binding?: unknown }).binding;
	if (!candidate || typeof (candidate as { run?: unknown }).run !== 'function') {
		return undefined;
	}
	return candidate as CloudflareAIBinding;
}

/**
 * Read AI Gateway options off a resolved Model, or `undefined` if none are
 * attached.
 */
export function getModelGateway<TApi extends Api>(
	model: Model<TApi>,
): CloudflareGatewayOptions | undefined {
	const candidate = (model as Model<TApi> & { gateway?: unknown }).gateway;
	if (!candidate || typeof (candidate as { id?: unknown }).id !== 'string') {
		return undefined;
	}
	return candidate as CloudflareGatewayOptions;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Resolve `'provider-id/model-id'` against the provider registry. */
export function resolveRegisteredModel(
	providerId: string,
	modelId: string,
): Model<Api> | undefined {
	const registration = providersById.get(providerId) ?? getBuiltInHttpProviderDefaults(providerId);
	if (!registration) return undefined;
	return buildModelFromRegistration(providerId, registration, modelId);
}

/**
 * Construct a pi-ai Model from a registered provider template. Binding
 * registrations hydrate metadata from pi-ai's `cloudflare-workers-ai`
 * catalog; HTTP registrations hydrate from the provider ID's own catalog
 * entry when one exists, with the registration's options layered on top and
 * any still-unset metadata defaulting to zero.
 */
function buildModelFromRegistration(
	providerId: string,
	registration: ProviderRegistration,
	modelId: string,
): Model<Api> {
	if (isCloudflareBindingRegistration(registration)) {
		// pi-ai's catalog covers only the chat-completion subset of Workers AI;
		// fall back to zero metadata for ids it doesn't know. The `shouldCompact`
		// guard treats `contextWindow <= 0` as unknown.
		const catalog = getModel('cloudflare-workers-ai' as KnownProvider, modelId as never);
		const base: Model<Api> = catalog
			? { ...catalog, api: CLOUDFLARE_AI_BINDING_API, provider: providerId, baseUrl: '' }
			: zeroMetadataModel(providerId, modelId, CLOUDFLARE_AI_BINDING_API, '');
		// Resolve the documented tri-state: omitted routes through Cloudflare's
		// default AI Gateway, `false` opts out, an options object replaces the
		// default.
		const gateway =
			registration.gateway === false ? undefined : (registration.gateway ?? { id: 'default' });
		return attachModelBinding(base, registration.binding, gateway);
	}

	// Hydrate from the catalog when the provider ID is known. For a known
	// provider whose catalog doesn't list this model ID (e.g. a gateway
	// exposing a brand-new model), provider-level transport facts still
	// hydrate from the provider's other catalog entries.
	const catalog = getModel(providerId as KnownProvider, modelId as never) as Model<Api> | undefined;
	const builtInDefaults = getBuiltInHttpProviderDefaults(providerId);
	const providerDefaults = catalog ?? getModels(providerId as KnownProvider)[0];
	const api = registration.api ?? providerDefaults?.api ?? builtInDefaults?.api;
	const baseUrl = registration.baseUrl ?? providerDefaults?.baseUrl ?? builtInDefaults?.baseUrl;
	if (api === undefined || baseUrl === undefined) {
		// Unreachable: registerProvider() rejects non-catalog registrations
		// that omit api/baseUrl.
		throw new ProviderRegistrationError({ providerId });
	}

	const base = catalog ?? zeroMetadataModel(providerId, modelId, api, baseUrl);
	const headers =
		base.headers || registration.headers ? { ...base.headers, ...registration.headers } : undefined;
	return {
		...base,
		api,
		provider: providerId,
		baseUrl,
		headers,
		contextWindow:
			registration.models?.[modelId]?.contextWindow ??
			registration.contextWindow ??
			base.contextWindow,
		maxTokens:
			registration.models?.[modelId]?.maxTokens ?? registration.maxTokens ?? base.maxTokens,
	};
}

/** Zero-metadata Model literal for ids no catalog knows. */
function zeroMetadataModel(
	providerId: string,
	modelId: string,
	api: Api,
	baseUrl: string,
): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		api,
		provider: providerId,
		baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	};
}
