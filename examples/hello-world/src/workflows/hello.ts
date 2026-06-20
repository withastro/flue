import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
	agent,
	async run({ harness, log }) {
		const session = await harness.session();
		const response = await session.prompt('What is 2 + 2? Return only the number.', {
			result: v.object({ answer: v.number() }),
		});
		log.info('solved arithmetic prompt', {
			answer: response.data.answer,
			tokens: response.usage.totalTokens,
			provider: response.model.provider,
			model: response.model.id,
		});
		await session.shell('cat AGENTS.md');
		return response.data;
	},
});
