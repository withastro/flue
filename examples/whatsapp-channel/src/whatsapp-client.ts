import type { WebhookMessage, WebhookValue, WhatsAppConversationRef } from '@flue/whatsapp';
import type { SendMessageResponse, WhatsAppClient } from '@kapso/whatsapp-cloud-api';

export function inboundConversationRef(
	businessAccountId: string,
	value: WebhookValue,
	message: WebhookMessage,
): WhatsAppConversationRef {
	const phoneNumberId = value.metadata.phone_number_id;
	if (message.group_id) {
		return { type: 'group', businessAccountId, phoneNumberId, groupId: message.group_id };
	}
	return {
		type: 'individual',
		businessAccountId,
		phoneNumberId,
		destination: { type: 'user-id', userId: message.from_user_id },
	};
}

/** The `WhatsAppConversationRef` fields `sendTextMessage()` actually sends on. */
export type WhatsAppSendRef =
	| {
			type: 'individual';
			phoneNumberId: string;
			destination:
				{ type: 'phone-number'; phoneNumber: string } | { type: 'user-id'; userId: string };
	  }
	| { type: 'group'; phoneNumberId: string; groupId: string };

export function sendTextMessage(
	client: WhatsAppClient,
	ref: WhatsAppSendRef,
	body: string,
): Promise<SendMessageResponse> {
	if (ref.type === 'group') {
		return client.messages.sendText({
			phoneNumberId: ref.phoneNumberId,
			recipientType: 'group',
			to: ref.groupId,
			body,
		});
	}
	if (ref.destination.type === 'phone-number') {
		return client.messages.sendText({
			phoneNumberId: ref.phoneNumberId,
			recipientType: 'individual',
			to: ref.destination.phoneNumber,
			body,
		});
	}
	return client.request<SendMessageResponse>('POST', `${ref.phoneNumberId}/messages`, {
		body: {
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			recipient: ref.destination.userId,
			type: 'text',
			text: { body },
		},
		responseType: 'json',
	});
}
