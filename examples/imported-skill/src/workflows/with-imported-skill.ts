import type { FlueContext, WorkflowRouteHandler } from '@flue/runtime';
import review from '../skills/review/SKILL.md' with { type: 'skill' };

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init }: FlueContext) {
	const harness = await init({ model: 'anthropic/claude-haiku-4-5', skills: [review] });
	const session = await harness.session();
	const response = await session.skill(review);
	return { text: response.text, reference: review };
}
