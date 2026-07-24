'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/teams.ts';

const initialDataSchema = v.object({
	serviceUrl: v.string(),
	conversationId: v.string(),
	botId: v.string(),
	threadId: v.optional(v.string()),
	conversationName: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Microsoft Teams channel dispatch.');
	useTool(postMessage(data));
	const conversationName = data.conversationName ? ` "${data.conversationName}"` : '';
	return `Reply concisely in the bound Microsoft Teams conversation${conversationName}.`;
}

Assistant.initialData = initialDataSchema;
