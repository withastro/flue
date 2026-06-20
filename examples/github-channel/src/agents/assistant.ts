import { defineAgent } from '@flue/runtime';
import { channel, commentOnIssue } from '../channels/github.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Review the issue and post a concise triage comment when appropriate.',
	tools: [commentOnIssue(channel.parseConversationKey(id))],
}));
