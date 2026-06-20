import { defineAgent, defineAgentProfile } from '@flue/runtime';

const scheduledAgent = defineAgentProfile({
	instructions: 'Complete scheduled tasks autonomously.',
});

export default defineAgent(() => ({ profile: scheduledAgent }));
