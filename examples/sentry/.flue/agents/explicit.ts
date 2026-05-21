import { http, type Agent, type AgentContext } from '@flue/runtime';

export const channels = [http()];

let explicitLog: AgentContext['log'];

export async function init({ spawn, log }: AgentContext): Promise<Agent> {
	explicitLog = log;
	return spawn({ model: false });
}

export async function onMessage() {
	try {
		throw new TypeError('downstream service returned an unexpected shape');
	} catch (error) {
		explicitLog.error('flaky downstream call failed; continuing with fallback', {
			error,
			service: 'fictional-pricing-api',
			retriable: false,
		});
	}
	explicitLog.error('low-confidence model output rejected', {
		confidence: 0.21,
		threshold: 0.5,
		action: 'fell back to deterministic path',
	});
	return { ok: true, fallbackUsed: true };
}
