import { defineAgent } from '@flue/runtime';
import { channel, retrieveConversation } from '../channels/intercom.ts';

export default defineAgent(({ id }) => {
	const conversation = channel.parseConversationKey(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Help with the inbound Intercom conversation. Retrieve the current conversation when more context is needed.',
		tools: [retrieveConversation(conversation)],
	};
});
