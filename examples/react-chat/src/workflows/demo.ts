import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

const agent = defineAgent(() => ({ model: false }));
export default defineWorkflow({
	agent,
	input: v.object({ requestedAt: v.string() }),
	async run({ log, input }) {
		log.info('workflow started', { requestedAt: input.requestedAt });
		await new Promise((resolve) => setTimeout(resolve, 500));
		log.info('workflow received input', { input });
		await new Promise((resolve) => setTimeout(resolve, 500));
		log.info('workflow completed');
		return { ok: true, requestedAt: input.requestedAt };
	},
});
