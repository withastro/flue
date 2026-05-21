import { defineAgent, type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

const auditor = defineAgent({
	name: 'auditor',
	thinkingLevel: 'high',
});
export default async function ({ init }: FlueContext) {
	const harness = await init({
		model: 'anthropic/claude-haiku-4-5',
		thinkingLevel: 'low',
		subagents: [auditor],
	});
	const session = await harness.session();

	const Answer = v.object({ answer: v.string() });

	const fast = await session.prompt('In one word: capital of France?', { result: Answer });

	const careful = await session.task('Is 1009 prime? Justify briefly.', {
		agent: 'auditor',
		result: Answer,
	});

	const minimal = await session.task('Echo back: hello', {
		agent: 'auditor',
		thinkingLevel: 'minimal',
		result: Answer,
	});

	return { fast, careful, minimal };
}
