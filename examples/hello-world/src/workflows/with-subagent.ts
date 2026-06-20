import {
	defineAgent,
	defineWorkflow,
	defineAgentProfile,
	type WorkflowRouteHandler,
} from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const greeter = defineAgentProfile({
	name: 'greeter',
	instructions: 'Write one warm, concise greeting.',
});
const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', subagents: [greeter] }));

export default defineWorkflow({
	agent,
	input: v.object({ name: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const { data } = await session.task(`Greet the user named "${input.name ?? 'Developer'}".`, {
			agent: 'greeter',
			result: v.object({ greeting: v.string() }),
		});
		return data;
	},
});
