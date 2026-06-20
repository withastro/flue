import {
	defineAgent,
	defineWorkflow,
	defineAgentProfile,
	type WorkflowRouteHandler,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const editor = defineAgentProfile({
	name: 'editor',
	instructions: 'Rewrite the supplied sentence in a clearer, shorter form.',
});
const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5', subagents: [editor] }));
export default defineWorkflow({
	agent,
	input: v.object({ draft: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const draft = input.draft ?? 'Our product helps teams work more efficiently together.';
		const response = await session.task(`Rewrite this sentence: ${draft}`, { agent: 'editor' });
		return { message: response.text };
	},
});
