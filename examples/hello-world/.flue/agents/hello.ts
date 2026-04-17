import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	const session = await init();

	// Test: prompt with structured result
	const result = await session.prompt('What is 2 + 2? Return only the number.', {
		result: v.object({ answer: v.number() }),
	});
	console.log('[hello] 2 + 2 =', result.answer);

	// Test: read a workspace file via shell
	const cat = await session.shell('cat AGENTS.md');
	console.log('[hello] AGENTS.md:', cat.stdout.trim());

	return result;
}
