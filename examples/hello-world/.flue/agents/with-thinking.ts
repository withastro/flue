import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

/**
 * Demonstrates the three layers at which `thinkingLevel` can be set:
 *   1. agent default     — `init({ thinkingLevel: 'low' })`
 *   2. role override     — `roles/auditor.md` sets `thinkingLevel: high`
 *   3. per-call override — `prompt(..., { thinkingLevel: 'minimal' })`
 *
 * One deployment, multiple reasoning tiers.
 */
export default async function ({ init }: FlueContext) {
	const agent = await init({
		model: 'anthropic/claude-haiku-4-5',
		// Agent default: cheap classifier-style calls.
		thinkingLevel: 'low',
	});
	const session = await agent.session();

	const Answer = v.object({ answer: v.string() });

	// 1. Agent default applies.
	const fast = await session.prompt('In one word: capital of France?', { result: Answer });

	// 2. Role overrides the agent default.
	const careful = await session.prompt('Is 1009 prime? Justify briefly.', {
		role: 'auditor',
		result: Answer,
	});

	// 3. Per-call override beats both agent default and role.
	const minimal = await session.prompt('Echo back: hello', {
		role: 'auditor',
		thinkingLevel: 'minimal',
		result: Answer,
	});

	return { fast, careful, minimal };
}
