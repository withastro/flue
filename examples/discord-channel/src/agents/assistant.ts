import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Post a concise answer to the bound Discord destination.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
