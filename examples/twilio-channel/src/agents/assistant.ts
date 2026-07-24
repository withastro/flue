'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/twilio.ts';

const initialDataSchema = v.variant('type', [
	v.object({ type: v.literal('address'), address: v.string(), participant: v.string() }),
	v.object({
		type: v.literal('messaging-service'),
		messagingServiceSid: v.string(),
		participant: v.string(),
	}),
]);

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Twilio channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Twilio conversation.';
}

Assistant.initialData = initialDataSchema;
