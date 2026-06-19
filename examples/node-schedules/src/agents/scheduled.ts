import { createAgent, defineAgentProfile } from '@flue/runtime';

const scheduledAgent = defineAgentProfile({
	instructions: 'Complete scheduled tasks autonomously.',
});

export default createAgent(() => ({ profile: scheduledAgent }));
