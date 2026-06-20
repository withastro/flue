import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		await session.prompt(
			'Use bash to fetch this Wikipedia article and summarize it in 2-3 sentences:\n' +
				'curl -sL "https://en.wikipedia.org/w/index.php?title=History_of_the_Internet&action=raw"',
		);
		const { data } = await session.prompt(
			'What Wikipedia article did you just read? What were the key points? Return a structured result.',
			{ result: v.object({ article: v.string(), keyPoints: v.array(v.string()) }) },
		);
		return data;
	},
});
