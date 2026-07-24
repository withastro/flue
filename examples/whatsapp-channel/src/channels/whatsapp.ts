import { defineTool, dispatch } from '@flue/runtime';
import { createWhatsAppChannel } from '@flue/whatsapp';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import {
	inboundConversationRef,
	sendTextMessage,
	type WhatsAppSendRef,
} from '../whatsapp-client.ts';

export const client = new WhatsAppClient({
	accessToken: requiredEnv('WHATSAPP_ACCESS_TOKEN'),
	graphVersion: 'v25.0',
});

export const channel = createWhatsAppChannel({
	appSecret: requiredEnv('WHATSAPP_APP_SECRET'),
	verifyToken: requiredEnv('WHATSAPP_VERIFY_TOKEN'),

	// Paths: GET and POST /channels/whatsapp/webhook
	async webhook({ payload }) {
		const expectedPhoneNumberId = requiredEnv('WHATSAPP_PHONE_NUMBER_ID');
		for (const entry of payload.entry) {
			for (const change of entry.changes) {
				if (change.field !== 'messages') continue;
				const value = change.value;
				// Filtering authenticated deliveries by phone number is application policy.
				if (value.metadata.phone_number_id !== expectedPhoneNumberId) continue;
				for (const message of value.messages ?? []) {
					if (message.type !== 'text' && message.type !== 'interactive') continue;
					const body =
						message.type === 'text'
							? message.text.body
							: (message.interactive.button_reply?.title ??
								message.interactive.list_reply?.title ??
								message.interactive.nfm_reply?.body ??
								'');
					const ref = inboundConversationRef(entry.id, value, message);
					await dispatch(Assistant, {
						id: channel.instanceId(ref),
						// Recorded once when this event creates the instance; ignored after.
						initialData: {
							phoneNumberId: ref.phoneNumberId,
							destination: ref.type === 'individual' ? ref.destination : undefined,
							groupId: ref.type === 'group' ? ref.groupId : undefined,
							contactName: value.contacts?.[0]?.profile?.name,
						},
						message: {
							kind: 'signal',
							type: `whatsapp.${message.type}`,
							body,
							attributes: { messageId: message.id },
						},
					});
				}
			}
		}
	},
});

export function postMessage(ref: WhatsAppSendRef) {
	return defineTool({
		name: 'post_whatsapp_message',
		description: 'Post a message to the WhatsApp conversation bound to this agent.',
		input: v.object({
			text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
		}),
		async run({ data }) {
			const result = await sendTextMessage(client, ref, data.text);
			const messageId = result.messages[0]?.id;
			return { ...(messageId === undefined ? {} : { messageId }) };
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
