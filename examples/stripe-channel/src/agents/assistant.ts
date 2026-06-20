import { defineAgent } from '@flue/runtime';
import { getCustomerSummary, parseStripeCustomerInstanceId } from '../channels/stripe.ts';

export default defineAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions:
		'Review the completed Checkout event and summarize any billing follow-up that is needed.',
	tools: [getCustomerSummary(parseStripeCustomerInstanceId(id))],
}));
