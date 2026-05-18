import { defineAgent, type ActionContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

const auditor = defineAgent({
	name: 'auditor',
	description: 'Carefully checks reasoning-heavy answers.',
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reason carefully before answering. Be concise and precise.',
});

const thinkingAgent = defineAgent({
	name: 'with-thinking',
	model: 'anthropic/claude-haiku-4-5',
	subagents: [auditor],
});

export default async function ({ init }: ActionContext) {
	const harness = await init({ agent: thinkingAgent, thinkingLevel: 'low' });
	const session = await harness.session();
	const Answer = v.object({ answer: v.string() });
	const fast = await session.prompt('In one word: capital of France?', { result: Answer });
	const careful = await session.task('Is 1009 prime? Justify briefly.', {
		agent: auditor,
		thinkingLevel: 'high',
		result: Answer,
	});
	const minimal = await session.task('Echo back: hello', {
		agent: auditor,
		thinkingLevel: 'minimal',
		result: Answer,
	});
	return { fast, careful, minimal };
}
