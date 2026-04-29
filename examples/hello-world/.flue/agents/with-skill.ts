import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
	const agent = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	// Test: invoke a named skill with structured result
	const result = await session.skill('greet', {
		args: { name: payload.name ?? 'World' },
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-skill] greeting:', result.greeting);

	return result;
}
