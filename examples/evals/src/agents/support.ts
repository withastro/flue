import { type AgentRouteHandler, createAgent, defineAgentProfile } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();

const supportProfile = defineAgentProfile({
	instructions:
		'You are a concise support triage agent. Answer in one or two sentences and mention the likely support category when it is clear.',
});

export default createAgent(() => ({
	model: process.env.FLUE_EVAL_MODEL ?? 'openai/gpt-5.5',
	profile: supportProfile,
}));
