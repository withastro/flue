import { describe, expect, it, vi } from 'vitest';
import { createTeamsClient } from '../src/lib/teams-client.ts';

describe('Microsoft Teams Fetch client', () => {
	it('acquires one OAuth token and replies through the Bot Connector in workerd', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/oauth2/v2.0/token')) {
				return Response.json({ access_token: 'teams-test-token', expires_in: 3600 });
			}
			return Response.json({ id: 'reply-activity-1' });
		});
		const client = createTeamsClient({
			appId: 'app-id',
			appPassword: 'app-password',
			tenantId: 'tenant-id',
			fetch: fetcher,
		});
		const destination = {
			tenantId: 'tenant-id',
			serviceUrl: 'https://smba.trafficmanager.net/amer/',
			conversationId: 'conversation/1',
			scope: 'channel' as const,
			botId: '28:bot-id',
			threadId: 'root:1',
			teamId: 'team-1',
			channelId: 'channel-1',
		};

		const first = await client.postMessage(destination, 'Hello from a Worker.');
		const second = await client.postMessage(destination, 'Token should be reused.');

		expect(first).toEqual({ id: 'reply-activity-1' });
		expect(second).toEqual({ id: 'reply-activity-1' });
		expect(fetcher).toHaveBeenCalledTimes(3);
		const [tokenUrl, tokenInit] = fetcher.mock.calls[0] ?? [];
		expect(String(tokenUrl)).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
		expect(tokenInit?.method).toBe('POST');
		expect(String(tokenInit?.body)).toContain(
			'scope=https%3A%2F%2Fapi.botframework.com%2F.default',
		);
		const [messageUrl, messageInit] = fetcher.mock.calls[1] ?? [];
		expect(String(messageUrl)).toBe(
			'https://smba.trafficmanager.net/amer/v3/conversations/conversation%2F1/activities/root%3A1',
		);
		expect(new Headers(messageInit?.headers).get('authorization')).toBe('Bearer teams-test-token');
		expect(JSON.parse(String(messageInit?.body))).toEqual({
			type: 'message',
			from: { id: '28:bot-id' },
			conversation: { id: 'conversation/1' },
			replyToId: 'root:1',
			text: 'Hello from a Worker.',
		});
	});
});
