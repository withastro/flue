import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/messenger.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound Facebook Messenger conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
