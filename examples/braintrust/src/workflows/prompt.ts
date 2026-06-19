import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init, payload }: FlueContext<{ name?: string }>) {
	const harness = await init({ model: 'anthropic/claude-haiku-4-5' });
	const session = await harness.session();
	const name = typeof payload.name === 'string' ? payload.name : 'Developer';
	const response = await session.prompt(`Write a one-sentence welcome for ${name}.`);
	return { message: response.text };
}
