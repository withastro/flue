'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveConversation } from '../channels/intercom.ts';

const initialDataSchema = v.object({
	workspaceId: v.string(),
	conversationId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Intercom channel dispatch.');
	useTool(retrieveConversation(data));
	return 'Help with the inbound Intercom conversation. Retrieve the current conversation when more context is needed.';
}

Assistant.initialData = initialDataSchema;
