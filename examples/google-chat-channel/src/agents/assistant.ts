'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/google-chat.ts';

const initialDataSchema = v.object({
	space: v.string(),
	thread: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Google Chat channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Google Chat conversation.';
}

Assistant.initialData = initialDataSchema;
