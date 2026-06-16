import { describe, expect, it } from 'vitest';
import {
	mergeFlueAdditions,
	validateUserWranglerConfig,
} from '../src/lib/cloudflare-wrangler-merge.ts';

const additions = {
	defaultName: 'fixture',
	main: '.flue-vite/_entry.ts',
	doBindings: [{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' }],
};

describe('mergeFlueAdditions()', () => {
	it('preserves a matching local Flue-generated Durable Object binding', () => {
		const binding = { name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' };
		const merged = mergeFlueAdditions({ durable_objects: { bindings: [binding] } }, additions) as {
			durable_objects: { bindings: unknown[] };
		};

		expect(merged.durable_objects.bindings).toEqual([binding]);
	});

	it('rejects an externally redirected Flue-generated Durable Object binding', () => {
		expect(() =>
			mergeFlueAdditions(
				{
					durable_objects: {
						bindings: [
							{
								name: 'FLUE_ASSISTANT_AGENT',
								class_name: 'FlueAssistantAgent',
								script_name: 'other-worker',
							},
						],
					},
				},
				additions,
			),
		).toThrow(
			'Expected a local class_name "FlueAssistantAgent" binding without script_name or environment.',
		);
	});

	it('rejects an externally redirected Flue-generated Durable Object binding in an environment', () => {
		expect(() =>
			mergeFlueAdditions(
				{
					env: {
						staging: {
							durable_objects: {
								bindings: [
									{
										name: 'FLUE_ASSISTANT_AGENT',
										class_name: 'FlueAssistantAgent',
										script_name: 'other-worker',
										environment: 'production',
									},
								],
							},
						},
					},
				},
				additions,
			),
		).toThrow(
			'Expected a local class_name "FlueAssistantAgent" binding without script_name or environment.',
		);
	});

	it('unions nodejs_compat into a compatibility_flags override in an environment', () => {
		const merged = mergeFlueAdditions(
			{ env: { staging: { compatibility_flags: ['some_flag'] } } },
			additions,
		) as { env: { staging: { compatibility_flags: string[] } } };

		expect(merged.env.staging.compatibility_flags).toEqual(['some_flag', 'nodejs_compat']);
	});

	it('leaves compatibility_flags unset in an environment without its own override', () => {
		const merged = mergeFlueAdditions({ env: { staging: {} } }, additions) as {
			compatibility_flags: string[];
			env: { staging: Record<string, unknown> };
		};

		expect(merged.compatibility_flags).toEqual(['nodejs_compat']);
		expect(merged.env.staging.compatibility_flags).toBeUndefined();
	});
});

describe('validateUserWranglerConfig()', () => {
	it('rejects a compatibility_flags override missing nodejs_compat in an environment', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: { env: { staging: { compatibility_flags: ['some_flag'] } } },
				effectiveConfig: { compatibility_flags: ['nodejs_compat'] },
			}),
		).toThrow('"env.staging.compatibility_flags" is missing "nodejs_compat"');
	});

	it('rejects a compatibility_date override below the supported floor in an environment', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: { env: { staging: { compatibility_date: '2025-01-01' } } },
				effectiveConfig: { compatibility_date: '2026-06-01' },
			}),
		).toThrow('"env.staging.compatibility_date" is "2025-01-01"');
	});
});
