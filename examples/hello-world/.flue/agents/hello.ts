import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, log }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();

	// Test: prompt with structured result
	const response = await session.prompt('What is 2 + 2? Return only the number.', {
		schema: v.object({ answer: v.number() }),
	});
	log.info('solved arithmetic prompt', {
		answer: response.data.answer,
		tokens: response.usage.totalTokens,
		model: response.model.id,
	});
	console.log('[hello] 2 + 2 =', response.data.answer);
	console.log('[hello] usage:', response.usage.totalTokens, 'tokens, model:', response.model.id);

	// Test: read a workspace file via shell
	const cat = await session.shell('cat AGENTS.md');
	console.log('[hello] AGENTS.md:', cat.stdout.trim());

	return response.data;
}
