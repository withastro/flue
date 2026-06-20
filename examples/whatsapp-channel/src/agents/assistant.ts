import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/whatsapp.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound WhatsApp conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
