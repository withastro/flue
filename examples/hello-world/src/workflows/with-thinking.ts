import {
	defineAgent,
	defineWorkflow,
	defineAgentProfile,
	type WorkflowRouteHandler,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const auditor = defineAgentProfile({ name: 'auditor', thinkingLevel: 'high' });
const agent = defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	thinkingLevel: 'low',
	subagents: [auditor],
}));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const Answer = v.object({ answer: v.string() });
		const fast = await session.prompt('In one word: capital of France?', { result: Answer });
		const careful = await session.task('Is 1009 prime? Justify briefly.', {
			agent: 'auditor',
			result: Answer,
		});
		const minimal = await session.task('Echo back: hello', {
			agent: 'auditor',
			thinkingLevel: 'minimal',
			result: Answer,
		});
		return { fast: fast.data, careful: careful.data, minimal: minimal.data };
	},
});
