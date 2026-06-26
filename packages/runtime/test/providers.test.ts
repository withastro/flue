import { getModel } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent, ProviderRegistrationError } from '../src/index.ts';
import { createFlueContext, resolveModel } from '../src/internal.ts';
import {
	getProviderTelemetry,
	registerProvider,
	resetProviderRuntime,
} from '../src/runtime/providers.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

afterEach(() => {
	resetProviderRuntime();
	vi.unstubAllGlobals();
});

/** Stub global fetch, capture outgoing requests, and answer with a valid SSE stream. */
function captureFetch(assistantText: string): Request[] {
	const seen: Request[] = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push(new Request(input, init));
		const encoder = new TextEncoder();
		const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
		const body = [
			chunk({
				id: 'chunk-1',
				object: 'chat.completion.chunk',
				created: 1,
				choices: [
					{ index: 0, delta: { role: 'assistant', content: assistantText }, finish_reason: null },
				],
			}),
			chunk({
				id: 'chunk-1',
				object: 'chat.completion.chunk',
				created: 1,
				choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			'data: [DONE]\n\n',
		].join('');
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(body));
					controller.close();
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' } },
		);
	});
	return seen;
}

/** Incidental harness plumbing; model resolution under test flows through `resolveModel`. */
function createContext() {
	return createFlueContext({
		id: 'providers-test-instance',
		env: {},
		agentConfig: {
			resolveModel,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
	});
}

describe('registerProvider()', () => {
	it('sends operations to the registered base URL when a model uses a registered provider id', async () => {
		const seen = captureFetch('Hello from the registered provider.');
		registerProvider('capture-http', {
			api: 'openai-completions',
			baseUrl: 'http://providers.test/v1',
			apiKey: 'sk-capture',
		});
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => ({ model: 'capture-http/capture-model' })),
		);
		const session = await harness.session();

		const response = await session.prompt('Say hello.');

		expect(seen).toHaveLength(1);
		const [request] = seen;
		if (!request) throw new Error('Expected a provider request.');
		const url = new URL(request.url);
		expect(url.origin).toBe('http://providers.test');
		expect(url.pathname).toBe('/v1/chat/completions');
		expect(response.text).toBe('Hello from the registered provider.');
		expect(response.model).toEqual({ provider: 'capture-http', id: 'capture-model' });
	});

	it('sends the registered api key and headers on outgoing requests when a registration supplies them', async () => {
		const seen = captureFetch('Authenticated.');
		registerProvider('capture-auth', {
			api: 'openai-completions',
			baseUrl: 'http://providers.test/v1',
			apiKey: 'sk-secret',
			headers: { 'x-gateway-tenant': 'acme' },
		});
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => ({ model: 'capture-auth/capture-model' })),
		);
		const session = await harness.session();

		await session.prompt('Say hello.');

		expect(seen).toHaveLength(1);
		const [request] = seen;
		if (!request) throw new Error('Expected a provider request.');
		expect(request.headers.get('authorization')).toBe('Bearer sk-secret');
		expect(request.headers.get('x-gateway-tenant')).toBe('acme');
	});

	it('preserves catalog model metadata when a catalog provider id is registered with transport overrides', () => {
		const catalog = getModel('anthropic', 'claude-sonnet-4-6');
		expect(catalog).toBeDefined();
		registerProvider('anthropic', {
			baseUrl: 'https://gateway.test/anthropic',
			apiKey: 'sk-gateway',
			headers: { 'x-gateway-tenant': 'acme' },
		});

		const resolved = resolveModel('anthropic/claude-sonnet-4-6');

		expect(resolved).toMatchObject({
			id: 'claude-sonnet-4-6',
			provider: 'anthropic',
			api: catalog.api,
			baseUrl: 'https://gateway.test/anthropic',
			cost: catalog.cost,
			contextWindow: catalog.contextWindow,
			maxTokens: catalog.maxTokens,
		});
		expect(resolved?.contextWindow).toBeGreaterThan(0);
		expect(resolved?.headers).toMatchObject({ 'x-gateway-tenant': 'acme' });
	});

	it('derives the wire protocol from the catalog when a registered catalog provider resolves an unlisted model id', () => {
		registerProvider('anthropic', { baseUrl: 'https://gateway.test/anthropic' });

		const resolved = resolveModel('anthropic/brand-new-model');

		expect(resolved).toMatchObject({
			id: 'brand-new-model',
			provider: 'anthropic',
			api: 'anthropic-messages',
			baseUrl: 'https://gateway.test/anthropic',
			contextWindow: 0,
			maxTokens: 0,
		});
	});

	it('uses only the latest registration when a provider id is registered repeatedly', () => {
		registerProvider('repeat-http', {
			api: 'openai-completions',
			baseUrl: 'http://first.test/v1',
			headers: { 'x-first': 'yes' },
			contextWindow: 32000,
		});
		registerProvider('repeat-http', {
			api: 'openai-completions',
			baseUrl: 'http://second.test/v1',
		});

		const resolved = resolveModel('repeat-http/some-model');

		expect(resolved).toMatchObject({ baseUrl: 'http://second.test/v1', contextWindow: 0 });
		expect(resolved?.headers).toBeUndefined();
	});

	it('applies per-model metadata overrides when a registration configures the resolved model id', () => {
		registerProvider('metadata-http', {
			api: 'openai-completions',
			baseUrl: 'http://models.test/v1',
			contextWindow: 8000,
			maxTokens: 1000,
			models: { tuned: { contextWindow: 200000, maxTokens: 8192 } },
		});

		expect(resolveModel('metadata-http/tuned')).toMatchObject({
			contextWindow: 200000,
			maxTokens: 8192,
		});
		expect(resolveModel('metadata-http/other')).toMatchObject({
			contextWindow: 8000,
			maxTokens: 1000,
		});
	});

	it('throws ProviderRegistrationError when a non-catalog provider id is registered without api and baseUrl', () => {
		expect(() => registerProvider('mystery-gateway', { apiKey: 'sk-test' })).toThrow(
			ProviderRegistrationError,
		);
		expect(() =>
			registerProvider('mystery-gateway', { baseUrl: 'http://mystery.test/v1' }),
		).toThrow(ProviderRegistrationError);
	});

	it('rejects a model specifier that omits its model id when its provider id is registered', () => {
		registerProvider('no-model-http', {
			api: 'openai-completions',
			baseUrl: 'http://no-model.test/v1',
		});

		expect(() => resolveModel('no-model-http/')).toThrow();
	});

	it('normalizes exact catalog provider ids without reclassifying gateways', () => {
		expect(getProviderTelemetry('amazon-bedrock')).toEqual({ providerName: 'aws.bedrock' });
		expect(getProviderTelemetry('google-vertex')).toEqual({ providerName: 'gcp.vertex_ai' });
		expect(getProviderTelemetry('mistral')).toEqual({ providerName: 'mistral_ai' });
		expect(getProviderTelemetry('cloudflare-ai-gateway')).toEqual({ providerName: 'cloudflare-ai-gateway' });
		expect(getProviderTelemetry('custom-openai-compatible')).toEqual({ providerName: 'custom-openai-compatible' });
	});

	it('preserves explicit telemetry provider identity over catalog normalization', () => {
		registerProvider('openai', {
			baseUrl: 'https://gateway.test/openai',
			telemetry: { providerName: 'company.gateway', serverAddress: 'gateway.test' },
		});

		expect(getProviderTelemetry('openai')).toEqual({
			providerName: 'company.gateway',
			serverAddress: 'gateway.test',
		});
	});

	it('removes provider registrations when a new runtime begins', () => {
		registerProvider('removed-http', {
			api: 'openai-completions',
			baseUrl: 'http://removed.test/v1',
		});
		expect(resolveModel('removed-http/model')).toBeDefined();

		resetProviderRuntime();

		expect(() => resolveModel('removed-http/model')).toThrow();
	});
});
