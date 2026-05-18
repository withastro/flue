import { defineAgent, type ActionContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

const greeter = defineAgent({
	name: 'greeter',
	description: 'Warmly greets a named user.',
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Greet users warmly. Include their name when provided and keep it concise.',
});

const greetingAgent = defineAgent({
	name: 'with-role',
	model: 'anthropic/claude-sonnet-4-6',
	subagents: [greeter],
});

export default async function ({ init, payload }: ActionContext) {
	const harness = await init({ agent: greetingAgent });
	const session = await harness.session();
	const { data } = await session.task(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		agent: greeter,
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-role] greeting:', data.greeting);
	return data;
}
