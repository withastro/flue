/**
 * Smoke test for the `models.json` model-discovery endpoint: the catalog Flue
 * ships on https://flueframework.com/models.json must actually contain the
 * model records this project advertises. If the endpoint's `pi-ai` pin lags
 * the runtime's, the discovery list silently omits models that work — which
 * is how GPT-6 Sol/Luna and Claude Opus 5.5 (pi 0.87.1) went missing on the
 * site while the runtime bumped past them.
 */
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it } from 'vitest';

function endpointSpecifiers(): string[] {
	const modelSpecifiers = getBuiltinProviders().flatMap((provider) =>
		getBuiltinModels(provider).map((model) => `${provider}/${model.id}`),
	);
	if (modelSpecifiers.length === 0) {
		throw new Error('No model specifiers found in the @earendil-works/pi-ai built-in catalog.');
	}
	return modelSpecifiers;
}

describe('models.json endpoint catalog', () => {
	it('contains the GPT-6 Sol/Luna and Claude Opus 5.5 records shipped by pi 0.87.1', () => {
		const specifiers = endpointSpecifiers();
		for (const expected of ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'anthropic/claude-opus-5-5']) {
			expect(specifiers, `catalog should include ${expected}`).toContain(expected);
		}
	});

	it('does not ship an empty catalog', () => {
		expect(endpointSpecifiers().length).toBeGreaterThan(0);
	});
});
