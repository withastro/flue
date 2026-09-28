import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	anthropicGatewayModelId,
	DYNAMIC_MODEL_MARKER,
	DYNAMIC_MODEL_TEMPLATE,
	getRuntimeModels,
	isAnthropicGatewayModel,
	isDynamicModel,
	resetDynamicModelWarnForTests,
	resetModelsForTests,
	resetVersionSeparatorAliasWarnForTests,
	resolveModel,
	setProvider,
} from './providers.ts';

function providerWith(providerId: string, models: Model<any>[], template?: unknown): Provider {
	const provider: Provider = {
		id: providerId,
		name: providerId,
		baseUrl: 'https://example.test',
		getModels: () => models,
		stream: () => {
			throw new Error('unused in this test');
		},
	} as unknown as Provider;
	if (template !== undefined) {
		(provider as unknown as Record<symbol, unknown>)[DYNAMIC_MODEL_TEMPLATE] = template;
	}
	return provider;
}

function markerOf(model: Model<Api>): unknown {
	return (model as Model<Api> & { [DYNAMIC_MODEL_MARKER]: true })[DYNAMIC_MODEL_MARKER];
}

afterEach(() => {
	resetModelsForTests();
	resetDynamicModelWarnForTests();
	resetVersionSeparatorAliasWarnForTests();
	vi.restoreAllMocks();
});

describe('dynamic model templates', () => {
	it('synthesizes a model marked as dynamic for ids no catalog knows', () => {
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		const model = resolveModel('test/fresh-model');
		expect(model.id).toBe('fresh-model');
		expect(isDynamicModel(model)).toBe(true);
		expect(markerOf(model)).toBe(true);
	});

	it('keeps a zero cost table so pi-ai can compute usage', () => {
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		const model = resolveModel('test/fresh-model');
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// `shouldCompact` treats a non-positive window as unknown.
		expect(model.contextWindow).toBe(0);
		expect(model.maxTokens).toBe(0);
	});

	it('does not mark catalog models', () => {
		setProvider(
			providerWith('test', [
				{
					id: 'known-model',
					name: 'Known Model',
					api: 'anthropic-messages',
					provider: 'test',
					baseUrl: 'https://example.test',
					reasoning: false,
					input: ['text'],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 500,
				},
			]),
		);
		const model = resolveModel('test/known-model');
		expect(isDynamicModel(model)).toBe(false);
		expect(markerOf(model)).toBeUndefined();
	});

	it('warns once per process when the template is used', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		resolveModel('test/first-unknown');
		resolveModel('test/second-unknown');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain('test/first-unknown');
		expect(warn.mock.calls[0]?.[0]).toContain('isDynamicModel');
	});
});

function catalogModel(providerId: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: 'anthropic-messages',
		provider: providerId,
		baseUrl: 'https://example.test',
		reasoning: false,
		input: ['text'],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 500,
	};
}

describe('version-separator aliases', () => {
	it('resolves a dashed version to the dotted catalog id', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(providerWith('test', [catalogModel('test', 'claude-sonnet-4.6')]));
		const model = resolveModel('test/claude-sonnet-4-6');
		expect(model.id).toBe('claude-sonnet-4.6');
		expect(isDynamicModel(model)).toBe(false);
	});

	it('resolves a dotted version to the dashed catalog id', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(providerWith('test', [catalogModel('test', 'claude-sonnet-4-6')]));
		expect(resolveModel('test/claude-sonnet-4.6').id).toBe('claude-sonnet-4-6');
	});

	it('prefers an exact match over an alias', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(
			providerWith('test', [
				catalogModel('test', 'claude-3.5-haiku'),
				catalogModel('test', 'claude-3-5-haiku'),
			]),
		);
		expect(resolveModel('test/claude-3-5-haiku').id).toBe('claude-3-5-haiku');
		expect(warn).not.toHaveBeenCalled();
	});

	it('does not alias when several catalog ids match', () => {
		setProvider(
			providerWith('test', [
				catalogModel('test', 'model-1.2-3'),
				catalogModel('test', 'model-1-2.3'),
			]),
		);
		expect(() => resolveModel('test/model-1-2-3')).toThrow('Unknown model ID');
	});

	it('does not alias ids that differ beyond version separators', () => {
		setProvider(providerWith('test', [catalogModel('test', 'claude-opus-5')]));
		expect(() => resolveModel('test/claude-opus-5-5')).toThrow('Unknown model ID');
	});

	it('prefers an alias over dynamic synthesis', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(
			providerWith('test', [catalogModel('test', 'claude-sonnet-4.6')], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		const model = resolveModel('test/claude-sonnet-4-6');
		expect(model.id).toBe('claude-sonnet-4.6');
		expect(isDynamicModel(model)).toBe(false);
	});

	it('warns once per requested specifier', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(providerWith('test', [catalogModel('test', 'claude-sonnet-4.6')]));
		resolveModel('test/claude-sonnet-4-6');
		resolveModel('test/claude-sonnet-4-6');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain('test/claude-sonnet-4.6');
	});
});

const GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}';

function gatewayModel(id: string, api: Api, vendor: string): Model<Api> {
	return {
		...catalogModel('cloudflare-ai-gateway', id),
		api,
		baseUrl: `${GATEWAY_BASE}/${vendor}`,
	};
}

describe('Cloudflare AI Gateway Anthropic ids', () => {
	it('dashes dotted versions', () => {
		expect(anthropicGatewayModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
		expect(anthropicGatewayModelId('claude-fable-5.1')).toBe('claude-fable-5-1');
		expect(anthropicGatewayModelId('claude-opus-5')).toBe('claude-opus-5');
		expect(anthropicGatewayModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
	});

	it('registers native Anthropic endpoint models under Anthropic ids', () => {
		setProvider(
			providerWith('cloudflare-ai-gateway', [
				gatewayModel('claude-sonnet-4.6', 'anthropic-messages', 'anthropic'),
				gatewayModel('claude-opus-5', 'anthropic-messages', 'anthropic'),
				gatewayModel('gpt-5.6-terra', 'openai-responses', 'openai'),
				gatewayModel('workers-ai/@cf/moonshotai/kimi-k2.6', 'openai-completions', 'compat'),
			]),
		);
		expect(getRuntimeModels().getModels('cloudflare-ai-gateway').map((model) => model.id)).toEqual([
			'claude-sonnet-4-6',
			'claude-opus-5',
			'gpt-5.6-terra',
			'workers-ai/@cf/moonshotai/kimi-k2.6',
		]);
		expect(resolveModel('cloudflare-ai-gateway/claude-sonnet-4-6').id).toBe('claude-sonnet-4-6');
	});

	it('resolves dotted specifiers to the Anthropic id', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(
			providerWith('cloudflare-ai-gateway', [
				gatewayModel('claude-sonnet-4.6', 'anthropic-messages', 'anthropic'),
			]),
		);
		expect(resolveModel('cloudflare-ai-gateway/claude-sonnet-4.6').id).toBe('claude-sonnet-4-6');
	});

	it('keeps one entry when the catalog lists both forms', () => {
		setProvider(
			providerWith('cloudflare-ai-gateway', [
				gatewayModel('claude-sonnet-4.6', 'anthropic-messages', 'anthropic'),
				gatewayModel('claude-sonnet-4-6', 'anthropic-messages', 'anthropic'),
			]),
		);
		expect(getRuntimeModels().getModels('cloudflare-ai-gateway').map((model) => model.id)).toEqual([
			'claude-sonnet-4-6',
		]);
	});

	it('leaves other providers unchanged', () => {
		setProvider(
			providerWith('cloudflare', [
				{ ...gatewayModel('anthropic/claude-sonnet-4.6', 'anthropic-messages', 'anthropic'), provider: 'cloudflare' },
			]),
		);
		expect(resolveModel('cloudflare/anthropic/claude-sonnet-4.6').id).toBe('anthropic/claude-sonnet-4.6');
	});

	it('leaves no dotted Anthropic ids in the shipped pi-ai gateway catalog', () => {
		setProvider(cloudflareAIGatewayProvider());
		const anthropic = getRuntimeModels()
			.getModels('cloudflare-ai-gateway')
			.filter(isAnthropicGatewayModel);
		expect(anthropic.length).toBeGreaterThan(0);
		expect(anthropic.filter((model) => /\d\.\d/.test(model.id)).map((model) => model.id)).toEqual([]);
		expect(resolveModel('cloudflare-ai-gateway/claude-sonnet-4-6').id).toBe('claude-sonnet-4-6');
	});
});
