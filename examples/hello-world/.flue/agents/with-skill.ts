import { http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const channels = [http()];

export async function init({ spawn }: AgentContext): Promise<Agent> {
	return spawn({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' });
}

export async function onMessage(agent: Agent, message: InboundMessage) {
	const harness = agent.harness();
	const session = await harness.session();

	// Test: invoke a named skill with structured result
	const name = typeof message.metadata.name === 'string' ? message.metadata.name : 'World';
	const { data } = await session.skill('greet', {
		args: { name },
		result: v.object({ greeting: v.string() }),
	});
	console.log('[with-skill] greeting:', data.greeting);

	return data;
}
