import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	const response = await session.prompt(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		role: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-role] greeting:', response.result.greeting);
	return response.result;
}
