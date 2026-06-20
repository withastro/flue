import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' }));

export default defineWorkflow({
	agent,
	input: v.object({ name: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const { data } = await session.skill('greet', {
			args: { name: input.name ?? 'World' },
			result: v.object({ greeting: v.string() }),
		});
		return data;
	},
});
