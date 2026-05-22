import { createAgent, defineAgentProfile, http, type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const channels = [http()];

const greeter = defineAgentProfile({
	name: 'greeter',
	instructions: 'Write one warm, concise greeting.',
});

const agent = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', subagents: [greeter] }));

export async function run({ init, payload }: FlueContext) {
	const harness = await init(agent);
	const session = await harness.session();

	const { data } = await session.task(`Greet the user named "${payload.name ?? 'Developer'}".`, {
		agent: 'greeter',
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-subagent] greeting:', data.greeting);
	return data;
}
