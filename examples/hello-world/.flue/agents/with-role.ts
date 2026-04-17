import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
	const session = await init();

	const result = await session.prompt(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		role: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-role] greeting:', result.greeting);
	return result;
}
