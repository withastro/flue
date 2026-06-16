import { describe, expect, it, vi } from 'vitest';
import { MessengerClient } from '../src/messenger-client.ts';

describe('MessengerClient', () => {
	it('sends a Page-scoped text reply and generic Graph request through Fetch in Node', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				Response.json({
					recipient_id: 'psid_node_81',
					message_id: 'm_node_82',
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					id: 'page_node_80',
					name: 'Node Page',
				}),
			);
		const client = new MessengerClient({
			pageId: 'page_node_80',
			pageAccessToken: 'page-token-node',
			graphVersion: 'v25.0',
			apiBaseUrl: 'https://graph.example.test',
			fetch,
		});

		const result = await client.messages.sendText({
			to: { type: 'page-scoped-id', id: 'psid_node_81' },
			text: 'Node reply',
			replyToMessageId: 'm_node_parent_83',
		});
		const page = await client.request<{ id: string; name: string }>('/v25.0/page_node_80', {
			query: { fields: 'id,name' },
		});

		expect(result).toEqual({
			recipientId: 'psid_node_81',
			messageId: 'm_node_82',
		});
		expect(page).toEqual({
			id: 'page_node_80',
			name: 'Node Page',
		});
		const messageUrl = fetch.mock.calls[0]?.[0] as URL;
		expect(messageUrl.origin + messageUrl.pathname).toBe(
			'https://graph.example.test/v25.0/page_node_80/messages',
		);
		expect(messageUrl.searchParams.get('access_token')).toBe('page-token-node');
		expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
			'content-type': 'application/json',
		});
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			recipient: { id: 'psid_node_81' },
			messaging_type: 'RESPONSE',
			message: {
				text: 'Node reply',
			},
			reply_to: { mid: 'm_node_parent_83' },
		});
		const requestUrl = fetch.mock.calls[1]?.[0] as URL;
		expect(requestUrl.searchParams.get('fields')).toBe('id,name');
	});
});
