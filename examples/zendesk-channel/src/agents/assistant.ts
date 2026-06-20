import { defineAgent } from '@flue/runtime';
import { channel, retrieveTicket } from '../channels/zendesk.ts';

export default defineAgent(({ id }) => {
	const ticket = channel.parseTicketKey(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Review the inbound Zendesk ticket event. Retrieve the current ticket when more context is needed.',
		tools: [retrieveTicket(ticket)],
	};
});
