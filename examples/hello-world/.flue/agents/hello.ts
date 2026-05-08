import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	// Test: prompt with structured result
	const response = await session.prompt('What is 2 + 2? Return only the number.', {
		result: v.object({ answer: v.number() }),
	});
	console.log('[hello] 2 + 2 =', response.result.answer);
	console.log('[hello] usage:', response.usage.totalTokens, 'tokens, model:', response.model.id);

	// Test: read a workspace file via shell
	const cat = await session.shell('cat AGENTS.md');
	console.log('[hello] AGENTS.md:', cat.stdout.trim());

	return response.result;
}
