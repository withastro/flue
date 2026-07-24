'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { getCustomerSummary } from '../channels/stripe.ts';

const initialDataSchema = v.object({
	customerId: v.string(),
	accountId: v.optional(v.string()),
	context: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Stripe channel dispatch.');
	useTool(getCustomerSummary(data));
	return 'Review the completed Checkout event and summarize any billing follow-up that is needed.';
}

Assistant.initialData = initialDataSchema;
