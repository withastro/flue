import { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

describe('grammY Api', () => {
	it('sends regular and business messages through Fetch in workerd', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					result: {
						message_id: 301,
						date: 1_781_102_001,
						chat: { id: -1_001_400_700, type: 'supergroup', title: 'Ops' },
						text: 'Investigating.',
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					result: {
						message_id: 302,
						date: 1_781_102_002,
						business_connection_id: 'business-cobalt',
						chat: { id: 881_209, type: 'private', first_name: 'Rhea' },
						text: 'The issue is resolved.',
					},
				}),
			);
		const client = new Api('123456:test-token', {
			apiRoot: 'https://telegram.example.test',
			fetch,
		});

		const regular = await client.sendMessage(-1_001_400_700, 'Investigating.', {
			message_thread_id: 44,
		});
		const business = await client.sendMessage(881_209, 'The issue is resolved.', {
			business_connection_id: 'business-cobalt',
		});

		expect(regular.message_id).toBe(301);
		expect(business.message_id).toBe(302);
		expect(fetch).toHaveBeenCalledTimes(2);
		const firstUrl = String(fetch.mock.calls[0]?.[0]);
		const secondUrl = String(fetch.mock.calls[1]?.[0]);
		expect(firstUrl).toBe('https://telegram.example.test/bot123456:test-token/sendMessage');
		expect(secondUrl).toBe(firstUrl);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			chat_id: -1_001_400_700,
			text: 'Investigating.',
			message_thread_id: 44,
		});
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
			chat_id: 881_209,
			text: 'The issue is resolved.',
			business_connection_id: 'business-cobalt',
		});
	});
});
