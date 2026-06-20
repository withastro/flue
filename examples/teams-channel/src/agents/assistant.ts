import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/teams.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound Microsoft Teams conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
