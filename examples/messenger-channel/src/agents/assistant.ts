'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/messenger.ts';

const initialDataSchema = v.object({
	pageId: v.string(),
	participant: v.variant('type', [
		v.object({ type: v.literal('page-scoped-id'), id: v.string() }),
		v.object({ type: v.literal('user-ref'), id: v.string() }),
	]),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Messenger channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Facebook Messenger conversation.';
}

Assistant.initialData = initialDataSchema;
