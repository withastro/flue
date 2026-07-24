'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveTicket } from '../channels/zendesk.ts';

const initialDataSchema = v.object({
	accountId: v.string(),
	ticketId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Zendesk channel dispatch.');
	useTool(retrieveTicket(data));
	return 'Review the inbound Zendesk ticket event. Retrieve the current ticket when more context is needed.';
}

Assistant.initialData = initialDataSchema;
