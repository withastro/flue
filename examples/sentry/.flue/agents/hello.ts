import { http, type Agent, type AgentContext } from '@flue/runtime';

export const channels = [http()];

let helloLog: AgentContext['log'];

export async function init({ spawn, log }: AgentContext): Promise<Agent> {
	helloLog = log;
	return spawn({ model: false });
}

export async function onMessage(agent: Agent) {
	helloLog.info('hello agent starting', { instanceId: agent.id });
	return { greeting: 'hello from flue', instanceId: agent.id };
}
