'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveCallback } from '../channels/salesforce-marketing-cloud.ts';

const initialDataSchema = v.object({
	callbackId: v.string(),
	mid: v.string(),
	eid: v.string(),
	jobId: v.string(),
	batchId: v.string(),
	listId: v.string(),
	subscriberId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) {
		throw new Error('This agent is created by the Salesforce Marketing Cloud channel dispatch.');
	}
	useTool(retrieveCallback(data));
	return 'Review the inbound Salesforce Marketing Cloud email lifecycle event. Retrieve the configured ENS callback when callback status or delivery configuration is relevant.';
}

Assistant.initialData = initialDataSchema;
