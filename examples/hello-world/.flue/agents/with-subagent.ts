import { defineAgent, type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

const greeter = defineAgent({
	name: 'greeter',
	instructions: 'Write one warm, concise greeting.',
});

export default async function ({ init, payload }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-sonnet-4-6', subagents: [greeter] });
	const session = await harness.session();

	const { data } = await session.task(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		agent: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-subagent] greeting:', data.greeting);
	return data;
}
