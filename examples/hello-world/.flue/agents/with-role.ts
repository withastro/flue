import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();

	const { data } = await session.prompt(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		role: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-role] greeting:', data.greeting);
	return data;
}
