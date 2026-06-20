import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();
const agent = defineAgent(() => ({ model: 'ollama/llama3.1:8b' }));

export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		return { ok: true, hasSession: typeof session === 'object' };
	},
});
