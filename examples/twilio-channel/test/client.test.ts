import { describe, expect, it, vi } from 'vitest';
import { TwilioClient } from '../src/twilio-client.ts';

describe('TwilioClient', () => {
	it('sends a message through Fetch in Node', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				sid: 'SM30303030303030303030303030303030',
				status: 'queued',
			}),
		);
		const client = new TwilioClient({
			accountSid: 'AC40404040404040404040404040404040',
			authToken: 'node-auth-token',
			apiBaseUrl: 'https://api.twilio.test',
			fetch,
		});

		const result = await client.messages.create({
			to: '+15557016016',
			from: '+15557017017',
			body: 'Node response',
			mediaUrl: ['https://assets.example.test/node.webp'],
			statusCallback: 'https://hooks.example.test/channels/twilio/status',
		});

		expect(result).toEqual({
			sid: 'SM30303030303030303030303030303030',
			status: 'queued',
		});
		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			'https://api.twilio.test/2010-04-01/Accounts/AC40404040404040404040404040404040/Messages.json',
		);
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: `Basic ${btoa('AC40404040404040404040404040404040:node-auth-token')}`,
			'content-type': 'application/x-www-form-urlencoded',
		});
		expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)))).toEqual(
			{
				To: '+15557016016',
				From: '+15557017017',
				Body: 'Node response',
				MediaUrl: 'https://assets.example.test/node.webp',
				StatusCallback: 'https://hooks.example.test/channels/twilio/status',
			},
		);
	});
});
