import { describe, expect, it } from 'vite-plus/test';
import { mergeFlueAdditions } from '../../cli/src/lib/cloudflare-wrangler-merge.ts';

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
});
