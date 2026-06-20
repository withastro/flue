import { defineAgent } from '@flue/runtime';
import { emailIdFromInstanceId, retrieveReceivedEmail } from '../channels/resend.ts';

export default defineAgent(({ id }) => {
	const emailId = emailIdFromInstanceId(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Review the inbound support email. Retrieve the complete email when its body or headers are needed.',
		tools: [retrieveReceivedEmail(emailId)],
	};
});
