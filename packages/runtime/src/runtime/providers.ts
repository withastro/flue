/** Runtime provider registries consumed by `resolveModel` and Session. */

import {
	registerApiProvider as piRegisterApiProvider,
	type Api,
	type Model,
} from '@mariozechner/pi-ai';
import type { CloudflareGatewayOptions } from '../cloudflare/gateway.ts';
import {
	CLOUDFLARE_AI_BINDING_API,
	CLOUDFLARE_AI_BINDING_PROVIDER,
} from '../cloudflare-model.ts';
import type { ProviderSettings } from '../types.ts';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Minimal Workers AI binding shape. Kept structural so `@flue/runtime/app` stays
 * importable on Node.
 */
export interface CloudflareAIBinding {
	run(
		model: string,
		inputs: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<Response | Record<string, unknown>>;
}

/**
 * Provider declarations keyed by URL prefix. HTTP providers carry endpoint
 * settings; Workers AI binding providers carry the captured binding object.
 */
export type ProviderRegistration =
	| HttpProviderRegistration
	| CloudflareAIBindingRegistration;

export interface HttpProviderRegistration {
	api: Api;
	/** Endpoint root, e.g. `'https://api.anthropic.com/v1'`. */
	baseUrl: string;
	/**
	 * Optional API key. Propagated to pi-ai via the harness's per-call
	 * `getApiKey(provider)` callback. Falls back to whatever pi-ai's normal
	 * env-var lookup produces if unset.
	 */
	apiKey?: string;
	/** Optional default headers for every outgoing request. */
	headers?: Record<string, string>;
	/**
	 * Override the pi-ai `provider` slug surfaced on AssistantMessage records
	 * and `configureProvider()` overrides. Defaults to the registry name.
	 */
	provider?: string;
}

export interface CloudflareAIBindingRegistration {
	api: typeof CLOUDFLARE_AI_BINDING_API;
	/** The captured `env.AI` reference. Read at registration time. */
	binding: CloudflareAIBinding;
	/**
	 * Override the pi-ai `provider` slug. Defaults to `'workers-ai'`,
	 * matching pi-ai's catalog convention for Cloudflare-Workers-AI models.
	 */
	provider?: string;
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
 * URL-prefix registry populated at module init by `app.ts` and generated
 * server entries.
 */
const userModels = new Map<string, ProviderRegistration>();

/**
 * Register a Flue-level model provider keyed by URL prefix.
 *
 * Last-write-wins. On Cloudflare, the generated entry reserves the
 * `cloudflare` prefix for the built-in Workers AI binding integration.
 */
export function registerProvider(
	name: string,
	registration: ProviderRegistration,
): void {
	userModels.set(name, registration);
}

/**
 * Internal read accessor. Returns the live map.
 */
export function getRegisteredProviders(): ReadonlyMap<string, ProviderRegistration> {
	return userModels;
}

/** Whether a URL prefix has already been registered. */
export function hasRegisteredProvider(name: string): boolean {
	return userModels.has(name);
}

/**
 * Look up a registration apiKey by the resolved pi-ai provider slug.
 */
export function getRegisteredApiKey(provider: string): string | undefined {
	for (const [name, def] of userModels) {
		const effective = effectiveProviderSlug(name, def);
		if (effective !== provider) continue;
		// Only HTTP registrations carry apiKey.
		if (!isCloudflareBindingRegistration(def)) return def.apiKey;
	}
	return undefined;
}

/**
 * Re-export of pi-ai's `registerApiProvider`. Use to register a brand-new
 * wire-protocol handler for an `api` slug pi-ai doesn't ship. Then call
 * {@link registerProvider} to alias a URL prefix to that api.
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

// ─── Provider override registry ─────────────────────────────────────────────
//
// Transport-level settings keyed by resolved pi-ai provider slug. This keeps
// built-in catalog metadata intact while letting apps patch auth/endpoints.

/**
 * Provider settings accepted by {@link configureProvider}.
 */
export type ProviderConfiguration = ProviderSettings;

const providerOverrides = new Map<string, ProviderSettings>();

/**
 * Patch transport-level settings on an existing provider while preserving its
 * resolved Model metadata (cost, context window, token limits, etc.).
 *
 * ```ts
 * import { configureProvider } from '@flue/runtime/app';
 *
 * configureProvider('anthropic', {
 *   baseUrl: 'https://gateway.example.com/anthropic',
 *   apiKey: process.env.GATEWAY_KEY,
 * });
 * ```
 *
 * Keyed by the resolved `Model.provider` value, not necessarily the URL
 * prefix. Last-write-wins.
 */
export function configureProvider(
	provider: string,
	settings: ProviderConfiguration,
): void {
	providerOverrides.set(provider, settings);
}

/**
 * Internal read accessor for provider overrides.
 */
export function getProviderConfiguration(
	provider: string,
): ProviderSettings | undefined {
	return providerOverrides.get(provider);
}

// ─── Model binding extension ────────────────────────────────────────────────

/**
 * Resolved Model with the captured Workers AI binding (and optional AI
 * Gateway options) attached as non-pi-ai extension fields. Flows from the
 * registration through the resolved Model to the Workers AI stream
 * function without going through AsyncLocalStorage.
 */
export type ModelWithBinding<TApi extends Api> = Model<TApi> & {
	binding: CloudflareAIBinding;
	gateway?: CloudflareGatewayOptions | false;
};

/** Attach a Workers AI binding (and optional gateway options) to a Model literal. */
export function attachModelBinding<TApi extends Api>(
	model: Model<TApi>,
	binding: CloudflareAIBinding,
	gateway?: CloudflareGatewayOptions | false,
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

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolve `'name/modelId'` against the URL-prefix registry.
 */
export function resolveRegisteredModel(
	name: string,
	modelId: string,
): Model<Api> | undefined {
	const def = userModels.get(name);
	if (!def) return undefined;
	return buildModelFromRegistration(name, def, modelId);
}

/**
 * Construct a pi-ai Model from a registered provider template. User-defined
 * providers do not have catalog metadata, so cost and context limits default
 * to zero. apiKey flows through `getApiKey`; it is not part of pi-ai's Model.
 */
function buildModelFromRegistration(
	name: string,
	def: ProviderRegistration,
	modelId: string,
): Model<Api> {
	if (isCloudflareBindingRegistration(def)) {
		const base: Model<Api> = {
			id: modelId,
			name: modelId,
			api: CLOUDFLARE_AI_BINDING_API,
			provider: def.provider ?? CLOUDFLARE_AI_BINDING_PROVIDER,
			baseUrl: '',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
		};
		return attachModelBinding(base, def.binding, def.gateway);
	}

	return {
		id: modelId,
		name: modelId,
		api: def.api,
		provider: def.provider ?? name,
		baseUrl: def.baseUrl,
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		headers: def.headers,
	};
}

/**
 * Compute the provider slug emitted on the resolved Model.
 */
function effectiveProviderSlug(name: string, def: ProviderRegistration): string {
	if (isCloudflareBindingRegistration(def)) {
		return def.provider ?? CLOUDFLARE_AI_BINDING_PROVIDER;
	}
	return def.provider ?? name;
}
