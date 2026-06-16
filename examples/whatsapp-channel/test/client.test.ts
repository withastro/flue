import type { WebhookMessage, WebhookValue, WhatsAppConversationRef } from '@flue/whatsapp';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { describe, expect, it, vi } from 'vitest';
import { inboundConversationRef, sendTextMessage } from '../src/whatsapp-client.ts';

describe('inboundConversationRef()', () => {
	it('uses the business-scoped user id when an inbound message also has a phone number', () => {
		const value = {
			metadata: {
				display_phone_number: '+15557006202',
				phone_number_id: 'phone_node_62',
			},
		} as WebhookValue;
		const message = {
			from: '+15557007202',
			from_user_id: 'US.synthetic-node-6202',
			id: 'wamid_inbound_node',
			timestamp: '1781280000',
			type: 'text',
			text: { body: 'Stable identity' },
		} as WebhookMessage;

		expect(inboundConversationRef('waba_node_62', value, message)).toEqual({
			type: 'individual',
			businessAccountId: 'waba_node_62',
			phoneNumberId: 'phone_node_62',
			destination: {
				type: 'user-id',
				userId: 'US.synthetic-node-6202',
			},
		});
	});
});

describe('sendTextMessage()', () => {
	it('sends a BSUID text message through the authenticated SDK request path in Node', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				messaging_product: 'whatsapp',
				contacts: [
					{
						input: 'US.synthetic-node-6202',
						user_id: 'US.synthetic-node-6202',
					},
				],
				messages: [{ id: 'wamid_outbound_node' }],
			}),
		);
		const client = new WhatsAppClient({
			accessToken: 'synthetic-node-access-token',
			graphVersion: 'v25.0',
			fetch,
		});
		const ref: WhatsAppConversationRef = {
			type: 'individual',
			businessAccountId: 'waba_node_62',
			phoneNumberId: 'phone_node_62',
			destination: {
				type: 'user-id',
				userId: 'US.synthetic-node-6202',
			},
		};

		const result = await sendTextMessage(client, ref, 'Node response');

		expect(result.messages[0]?.id).toBe('wamid_outbound_node');
		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			'https://graph.facebook.com/v25.0/phone_node_62/messages',
		);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			recipient: 'US.synthetic-node-6202',
			type: 'text',
			text: { body: 'Node response' },
		});
	});
});
