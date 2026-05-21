import { defineAgent, http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';
import * as v from 'valibot';

const greeter = defineAgent({
	model: 'anthropic/claude-sonnet-4-6',
	instructions: 'Greet users warmly and concisely.',
});

export const channels = [http()];

export async function init({ spawn }: AgentContext): Promise<Agent> {
	return spawn({ inherit: greeter });
}

export async function onMessage(agent: Agent, message: InboundMessage) {
	const harness = agent.harness();
	const session = await harness.session();
	const name = typeof message.metadata.name === 'string' ? message.metadata.name : 'Developer';

	const { data } = await session.prompt(`Greet the user named "${name}".`, {
		result: v.object({ greeting: v.string() }),
	});

	console.log('[with-inherit] greeting:', data.greeting);
	return data;
}
