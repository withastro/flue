import type { FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
	const harness = await init({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();

	// Test: invoke a named skill with structured result
	const { data } = await session.skill('greet', {
		args: { name: payload.name ?? 'World' },
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-skill] greeting:', data.greeting);

	return data;
}
