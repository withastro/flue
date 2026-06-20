import { defineAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply in the bound Slack thread when appropriate.',
	tools: [replyInThread(channel.parseConversationKey(id))],
}));
