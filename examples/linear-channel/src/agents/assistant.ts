import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/linear.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound Linear conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
