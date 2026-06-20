import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (c, next) => {
	const request = c.req.raw;
	console.log('[with-request] method:', request.method);
	console.log('[with-request] url:', request.url);
	console.log('[with-request] user-agent:', request.headers.get('user-agent'));
	console.log('[with-request] raw body:', await request.clone().text());
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	console.log('[with-request] ip:', ip);
	if (!request.headers.get('authorization')) return c.json({ error: 'unauthorized' }, 401);
	await next();
};

const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
export default defineWorkflow({
	agent,
	async run({ harness }) {
		const session = await harness.session();
		const { text } = await session.prompt('Say hello in 5 words.');
		return { text };
	},
});
