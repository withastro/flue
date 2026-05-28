import { type FetchLike, readJsonResponse, requireEnvToken } from './http.ts';

export interface SlackSearchInput {
	query: string;
	limit?: number;
	after?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

export interface SlackThreadInput {
	channel?: string;
	threadTs?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

export interface SlackSearchResult {
	ok: true;
	query: string;
	results: Array<{
		channel: string;
		author: string;
		text: string;
		permalink?: string;
		reply_count: number;
	}>;
}

export interface SlackThreadResult {
	ok: true;
	channel: string;
	thread_ts: string;
	messages: Array<{
		author: string;
		user_id: string;
		text: string;
		ts?: string;
	}>;
}

const SLACK_SEARCH_URL = 'https://slack.com/api/assistant.search.context';
const SLACK_API_URL = 'https://slack.com/api';

export async function searchSlack(input: SlackSearchInput): Promise<SlackSearchResult> {
	const token = input.token || requireEnvToken('SLACK_USER_TOKEN', 'Connect Slack for the current user before searching.');
	const limit = Math.min(input.limit ?? 10, 20);
	const fetcher = input.fetchImpl ?? fetch;
	const body: Record<string, unknown> = {
		query: input.query,
		content_types: ['messages'],
		limit,
	};
	if (input.after) body.after = dateToUnixSeconds(input.after);

	const response = await fetcher(SLACK_SEARCH_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	const data = await readJsonResponse(response, 'Slack search');
	if (!data.ok) throw new Error(`Slack search failed: ${data.error || 'unknown_error'}`);

	const messages = Array.isArray(data.results?.messages) ? data.results.messages : [];
	return {
		ok: true,
		query: input.query,
		results: messages.map((message: any) => ({
			channel: String(message.channel_name || message.channel_id || ''),
			author: String(message.author_name || message.user_name || 'unknown'),
			text: String(message.content || message.text || '').slice(0, 2000),
			permalink: optionalString(message.permalink),
			reply_count: Number(message.reply_count) || 0,
		})),
	};
}

export async function readSlackThread(input: SlackThreadInput = {}): Promise<SlackThreadResult> {
	const token = input.token || requireEnvToken('SLACK_BOT_TOKEN', 'Slack thread reading requires bot access.');
	const channel =
		input.channel || requireEnvToken('SLACK_CHANNEL', 'Slack thread reading requires SLACK_CHANNEL.');
	const threadTs =
		input.threadTs || requireEnvToken('SLACK_THREAD_TS', 'Slack thread reading requires SLACK_THREAD_TS.');
	const fetcher = input.fetchImpl ?? fetch;
	const params = new URLSearchParams({ channel, ts: threadTs });
	const response = await fetcher(`${SLACK_API_URL}/conversations.replies?${params}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = await readJsonResponse(response, 'Slack thread');
	if (!data.ok) throw new Error(`Slack thread read failed: ${data.error || 'unknown_error'}`);

	const nameCache = new Map<string, string>();
	const rawMessages = Array.isArray(data.messages) ? data.messages : [];
	const messages = [];
	for (const message of rawMessages) {
		if (message.bot_id) continue;
		const userId = String(message.user || 'unknown');
		if (!nameCache.has(userId)) {
			nameCache.set(userId, await getSlackDisplayName(fetcher, token, userId));
		}
		messages.push({
			author: nameCache.get(userId) || userId,
			user_id: userId,
			text: String(message.text || ''),
			ts: optionalString(message.ts),
		});
	}

	return { ok: true, channel, thread_ts: threadTs, messages };
}

async function getSlackDisplayName(fetcher: FetchLike, token: string, userId: string): Promise<string> {
	const params = new URLSearchParams({ user: userId });
	const response = await fetcher(`${SLACK_API_URL}/users.info?${params}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = await readJsonResponse(response, 'Slack users.info');
	if (!data.ok) return userId;
	return String(data.user?.display_name || data.user?.real_name || userId);
}

function dateToUnixSeconds(date: string): number {
	const parsed = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(parsed)) throw new Error('after must be an ISO date like YYYY-MM-DD.');
	return Math.floor(parsed / 1000);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}
