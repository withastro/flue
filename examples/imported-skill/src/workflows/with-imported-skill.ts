import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import review from '../skills/review/SKILL.md' with { type: 'skill' };

export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5', skills: [review] }));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const response = await session.skill(review);
		return { text: response.text, reference: review.name };
	},
});
