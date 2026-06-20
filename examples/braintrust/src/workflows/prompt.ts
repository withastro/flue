import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
export default defineWorkflow({
	agent,
	input: v.object({ name: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const response = await session.prompt(
			`Write a one-sentence welcome for ${input.name ?? 'Developer'}.`,
		);
		return { message: response.text };
	},
});
