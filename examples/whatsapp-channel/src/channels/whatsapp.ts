import { defineTool, dispatch } from '@flue/runtime';
import { createWhatsAppChannel, type WhatsAppConversationRef } from '@flue/whatsapp';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import assistant from '../agents/assistant.ts';
import { inboundConversationRef, sendTextMessage } from '../whatsapp-client.ts';

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
					await dispatch(assistant, {
						id: channel.conversationKey(inboundConversationRef(entry.id, value, message)),
						input: {
							type: `whatsapp.${message.type}`,
							messageId: message.id,
							message,
						},
					});
				}
			}
		}
	},
});

export function postMessage(ref: WhatsAppConversationRef) {
	return defineTool({
		name: 'post_whatsapp_message',
		description: 'Post a message to the WhatsApp conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1, maxLength: 4096 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const result = await sendTextMessage(client, ref, text);
			return JSON.stringify({ messageId: result.messages[0]?.id });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
