import { type AgentRouteHandler, defineAgent, defineAgentProfile } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();

const assistant = defineAgentProfile({
	instructions: 'You complete task requests submitted directly to this agent.',
});

export default defineAgent(() => ({ profile: assistant }));
