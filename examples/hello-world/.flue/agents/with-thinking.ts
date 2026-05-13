import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

/**
 * Demonstrates the three layers at which `thinkingLevel` can be set:
 *   1. harness default   — `init({ thinkingLevel: 'low' })`
 *   2. role override     — `roles/auditor.md` sets `thinkingLevel: high`
 *   3. per-call override — `prompt(..., { thinkingLevel: 'minimal' })`
 *
 * One deployment, multiple reasoning tiers.
 */
export default async function ({ init }: FlueContext) {
	const harness = await init({
		model: 'anthropic/claude-haiku-4-5',
		// Harness default: cheap classifier-style calls.
		thinkingLevel: 'low',
	});
	const session = await harness.session();

	const Answer = v.object({ answer: v.string() });

	// 1. Harness default applies.
	const fast = await session.prompt('In one word: capital of France?', { schema: Answer });

	// 2. Role overrides the harness default.
	const careful = await session.prompt('Is 1009 prime? Justify briefly.', {
		role: 'auditor',
		schema: Answer,
	});

	// 3. Per-call override beats both harness default and role.
	const minimal = await session.prompt('Echo back: hello', {
		role: 'auditor',
		thinkingLevel: 'minimal',
		schema: Answer,
	});

	return { fast, careful, minimal };
}
