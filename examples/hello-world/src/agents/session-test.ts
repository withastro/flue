import { type AgentRouteHandler, defineAgent, defineAgentProfile } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();

const sessionTest = defineAgentProfile({
	instructions: 'You are a test agent for session-oriented message delivery.',
});

export default defineAgent(() => ({ profile: sessionTest }));
