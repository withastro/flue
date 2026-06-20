import { defineAgent } from '@flue/runtime';
import { retrieveCallback } from '../channels/salesforce-marketing-cloud.ts';
import { parseEmailEventInstanceId } from '../salesforce-marketing-cloud-email.ts';

export default defineAgent(({ id }) => {
	const email = parseEmailEventInstanceId(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Review the inbound Salesforce Marketing Cloud email lifecycle event. Retrieve the configured ENS callback when callback status or delivery configuration is relevant.',
		tools: [retrieveCallback(email)],
	};
});
