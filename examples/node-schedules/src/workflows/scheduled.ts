import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

const agent = defineAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));
export default defineWorkflow({
	agent,
	input: v.object({ prompt: v.string(), scheduledAt: v.string() }),
	async run({ harness, input }) {
		const session = await harness.session();
		const response = await session.prompt(input.prompt);
		return { text: response.text, scheduledAt: input.scheduledAt };
	},
});
