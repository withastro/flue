import { defineAgent } from '@flue/runtime';
import { parseShopifyOrderInstanceId, retrieveOrder } from '../channels/shopify.ts';

export default defineAgent(({ id }) => {
	const order = parseShopifyOrderInstanceId(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Review the newly created Shopify order and summarize any fulfillment or payment follow-up.',
		tools: [retrieveOrder(order)],
	};
});
