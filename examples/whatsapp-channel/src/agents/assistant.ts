'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/whatsapp.ts';
import type { WhatsAppSendRef } from '../whatsapp-client.ts';

const initialDataSchema = v.object({
	phoneNumberId: v.string(),
	destination: v.optional(
		v.union([
			v.object({ type: v.literal('phone-number'), phoneNumber: v.string() }),
			v.object({ type: v.literal('user-id'), userId: v.string() }),
		]),
	),
	groupId: v.optional(v.string()),
	contactName: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the WhatsApp channel dispatch.');
	let ref: WhatsAppSendRef;
	if (data.groupId !== undefined) {
		ref = { type: 'group', phoneNumberId: data.phoneNumberId, groupId: data.groupId };
	} else if (data.destination !== undefined) {
		ref = { type: 'individual', phoneNumberId: data.phoneNumberId, destination: data.destination };
	} else {
		throw new Error('WhatsApp instance data is missing a destination.');
	}
	useTool(postMessage(ref));
	const contactName = data.contactName ? ` with ${data.contactName}` : '';
	return `Reply concisely in the bound WhatsApp conversation${contactName}.`;
}

Assistant.initialData = initialDataSchema;
