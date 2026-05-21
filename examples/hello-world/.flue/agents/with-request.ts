import { http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';

export const channels = [http()];

export async function init({ spawn, register, metadata }: AgentContext): Promise<Agent> {
	const agent = await spawn({ model: 'anthropic/claude-haiku-4-5' });
	await register(async () => {
		if (typeof metadata.seedWorkspace === 'string') {
			await agent.harness().fs.writeFile('/registered-workspace.txt', metadata.seedWorkspace);
		}
	});
	return agent;
}

export async function onMessage(agent: Agent, message: InboundMessage) {
	const harness = agent.harness();
	const delayMs = message.metadata.delayMs;
	if (typeof delayMs === 'number' && delayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	if (message.metadata.readWorkspace) {
		return {
			skipped: true,
			workspace: await harness.fs.readFile('/registered-workspace.txt').catch(() => null),
		};
	}
	return {
		skipped: true,
		reason: 'raw request/header access moved out of the agent message surface',
	};
}
