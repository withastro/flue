import { describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../src/index.ts';
import { createSlackChannel, type SlackAppMentionEvent } from '../src/slack.ts';

const slackSecret = 'slack-secret';
const slackTimestamp = '1710000000';

async function signSlackBody(body: string): Promise<string> {
	return `v0=${await hmacSha256Hex(slackSecret, `v0:${slackTimestamp}:${body}`)}`;
}

async function createSlackRequest(body: string, init?: {
	readonly contentType?: string;
	readonly retryNum?: string;
	readonly retryReason?: string;
	readonly signature?: string;
}): Promise<Request> {
	const headers = new Headers({
		'content-type': init?.contentType ?? 'application/json',
		'x-slack-request-timestamp': slackTimestamp,
		'x-slack-signature': init?.signature ?? await signSlackBody(body),
	});
	if (init?.retryNum) headers.set('x-slack-retry-num', init.retryNum);
	if (init?.retryReason) headers.set('x-slack-retry-reason', init.retryReason);
	return new Request('https://example.com/slack', { method: 'POST', headers, body });
}

describe('createSlackChannel()', () => {
	it('returns the Slack challenge when URL verification is signed', async () => {
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		const request = await createSlackRequest(JSON.stringify({
			type: 'url_verification',
			challenge: 'challenge-token',
		}));

		const response = await channel.fetch(request);

		await expect(response.json()).resolves.toEqual({ challenge: 'challenge-token' });
	});

	it('rejects requests when the Slack signature is invalid', async () => {
		const handler = vi.fn();
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		channel.on('app_mention', handler);
		const request = await createSlackRequest(JSON.stringify({
			type: 'event_callback',
			event_id: 'Ev1',
			team_id: 'T1',
			event: {
				type: 'app_mention',
				channel: 'C1',
				user: 'U1',
				text: '<@BOT> hello',
				ts: '123.45',
			},
		}), { signature: 'v0=bad' });

		const response = await channel.fetch(request);

		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('delivers signed app mention events to registered handlers', async () => {
		const handler = vi.fn<(event: SlackAppMentionEvent) => void>();
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		channel.on('app_mention', handler);
		const request = await createSlackRequest(JSON.stringify({
			type: 'event_callback',
			event_id: 'Ev1',
			team_id: 'T1',
			event: {
				type: 'app_mention',
				channel: 'C1',
				user: 'U1',
				text: '<@BOT> hello',
				ts: '123.45',
			},
		}), { retryNum: '1', retryReason: 'http_timeout' });

		const response = await channel.fetch(request);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({
			type: 'app_mention',
			eventId: 'Ev1',
			teamId: 'T1',
			channelId: 'C1',
			threadTs: '123.45',
			messageTs: '123.45',
			text: '<@BOT> hello',
			userId: 'U1',
			retryNum: '1',
			retryReason: 'http_timeout',
		}));
	});

	it('delivers signed message events when Slack text is empty', async () => {
		const handler = vi.fn();
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		channel.on('message', handler);
		const request = await createSlackRequest(JSON.stringify({
			type: 'event_callback',
			event_id: 'Ev-empty',
			team_id: 'T1',
			event: {
				type: 'message',
				channel: 'C1',
				user: 'U1',
				text: '',
				ts: '123.45',
			},
		}));

		const response = await channel.fetch(request);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({
			type: 'message',
			eventId: 'Ev-empty',
			text: '',
		}));
	});

	it('passes fetch context to lazy Slack configuration when verifying requests', async () => {
		const handler = vi.fn();
		const channel = createSlackChannel<{ signingSecret: string }>({
			signingSecret: ({ context }) => context?.signingSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		channel.on('app_mention', handler);
		const request = await createSlackRequest(JSON.stringify({
			type: 'event_callback',
			event_id: 'Ev1',
			team_id: 'T1',
			event: {
				type: 'app_mention',
				channel: 'C1',
				user: 'U1',
				text: '<@BOT> hello',
				ts: '123.45',
			},
		}));

		const response = await channel.fetch(request, { signingSecret: slackSecret });

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('returns a retryable status when a handler fails', async () => {
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});
		channel.on('message', async () => {
			throw new Error('dispatch unavailable');
		});
		const request = await createSlackRequest(JSON.stringify({
			type: 'event_callback',
			event_id: 'Ev2',
			team_id: 'T1',
			event: {
				type: 'message',
				channel: 'C1',
				user: 'U1',
				text: 'hello',
				ts: '123.45',
			},
		}));

		const response = await channel.fetch(request);

		expect(response.status).toBe(500);
	});

	it('posts replies through a trusted thread tool', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
		const channel = createSlackChannel<{ botToken: string }>({
			signingSecret: slackSecret,
			botToken: ({ context }) => context?.botToken,
			fetch: fetchMock,
			now: () => Number(slackTimestamp) * 1000,
		});
		const tool = channel.tools.replyInThread(
			{ teamId: 'T1', channelId: 'C1', threadTs: '123.45' },
			{ botToken: 'xoxb-token' },
		);

		await expect(tool.execute({ text: 'approved' })).resolves.toBe('Reply sent.');

		expect(fetchMock).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', expect.objectContaining({
			method: 'POST',
			headers: expect.objectContaining({
				authorization: 'Bearer xoxb-token',
			}),
			body: JSON.stringify({
				channel: 'C1',
				text: 'approved',
				thread_ts: '123.45',
			}),
		}));
	});

	it('round-trips Slack conversation keys', () => {
		const channel = createSlackChannel({
			signingSecret: slackSecret,
			now: () => Number(slackTimestamp) * 1000,
		});

		const key = channel.conversationKey({ teamId: 'T1', channelId: 'C1', threadTs: '123.45' });

		expect(key).toBe('T1:C1:123.45');
		expect(channel.parseConversationKey(key)).toEqual({ teamId: 'T1', channelId: 'C1', threadTs: '123.45' });
	});
});
