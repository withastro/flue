import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export async function run({ init, payload }: FlueContext<{ prompt: string; scheduledAt: string }>) {
	const harness = await init(agent);
	const session = await harness.session();
	const response = await session.prompt(payload.prompt);
	return { text: response.text, scheduledAt: payload.scheduledAt };
}
