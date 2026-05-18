import { defineAgent, type ActionContext } from '@flue/runtime';
import greet from '../../.agents/skills/greet/SKILL.md' with { type: 'skill' };
import * as v from 'valibot';

export const triggers = { webhook: true };

const greetingAgent = defineAgent({
	name: 'with-skill',
	model: 'anthropic/claude-sonnet-4-6',
	skills: [greet],
});

export default async function ({ init, payload }: ActionContext) {
	const harness = await init({ agent: greetingAgent });
	const session = await harness.session();
	const { data } = await session.skill(greet, {
		args: { name: payload.name ?? 'World' },
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-skill] greeting:', data.greeting);
	return data;
}
