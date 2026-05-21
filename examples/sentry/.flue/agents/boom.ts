import { http, type Agent, type AgentContext } from '@flue/runtime';

export const channels = [http()];

let boomLog: AgentContext['log'];

export async function init({ spawn, log }: AgentContext): Promise<Agent> {
	boomLog = log;
	return spawn({ model: false });
}

export async function onMessage() {
	boomLog.info('boom agent about to explode', { reason: 'demo' });
	throw new Error('intentional explosion for the Sentry demo');
}
