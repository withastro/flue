import { http, type Agent, type AgentContext } from '@flue/runtime';
import * as v from 'valibot';

export const channels = [http()];

let helloLog: AgentContext['log'];

export async function init({ spawn, log }: AgentContext): Promise<Agent> {
	helloLog = log;
	return spawn({ model: 'anthropic/claude-sonnet-4-6' });
}

export async function onMessage(agent: Agent) {
	const harness = agent.harness();
	const session = await harness.session();

	// Test: prompt with structured result
	const response = await session.prompt('What is 2 + 2? Return only the number.', {
		result: v.object({ answer: v.number() }),
	});
	helloLog.info('solved arithmetic prompt', {
		answer: response.data.answer,
		tokens: response.usage.totalTokens,
		model: response.model.id,
	});
	console.log('[hello] 2 + 2 =', response.data.answer);
	console.log('[hello] usage:', response.usage.totalTokens, 'tokens, model:', response.model.id);

	// Test: read a workspace file via shell
	const cat = await session.shell('cat AGENTS.md');
	console.log('[hello] AGENTS.md:', cat.stdout.trim());

	return response.data;
}
