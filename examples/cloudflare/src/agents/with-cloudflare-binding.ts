import { type AgentRouteHandler, defineAgent, defineAgentProfile } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();

const cloudflareBinding = defineAgentProfile({
	model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
	instructions: 'You process direct requests using a Cloudflare Workers AI binding.',
});

export default defineAgent(() => ({ profile: cloudflareBinding }));
