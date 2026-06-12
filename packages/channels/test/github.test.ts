import { describe, expect, it, vi } from 'vitest';
import { createGitHubChannel, type GitHubChannelEvent, type GitHubIssuesOpenedEvent } from '../src/github.ts';
import { hmacSha256Hex } from '../src/index.ts';

const githubSecret = 'github-secret';

function issueNumberFromKnownGitHubEvent(event: GitHubChannelEvent): number | undefined {
	if (event.type === 'issues.opened') return event.issue.number;
	if (event.type === 'issue_comment.created') return event.issue.number;
	if (event.type === 'pull_request.opened') return event.pullRequest.number;
	if (event.type === 'pull_request_review_comment.created') return event.comment.id;
}

async function createGitHubRequest(eventName: string, deliveryId: string, body: string, signature?: string): Promise<Request> {
	return new Request('https://example.com/github', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': deliveryId,
			'x-github-event': eventName,
			'x-hub-signature-256': signature ?? `sha256=${await hmacSha256Hex(githubSecret, body)}`,
		},
		body,
	});
}

describe('createGitHubChannel()', () => {
	it('preserves type narrowing for shared known event handlers', () => {
		const event = {
			type: 'issues.opened',
			action: 'opened',
			deliveryId: 'delivery-typed',
			eventName: 'issues',
			owner: 'withastro',
			repo: 'flue',
			number: 123,
			issue: { number: 123 },
			payload: {},
			raw: {},
		} satisfies GitHubChannelEvent;

		expect(issueNumberFromKnownGitHubEvent(event)).toBe(123);
	});

	it('delivers signed issue events to registered handlers', async () => {
		const handler = vi.fn<(event: GitHubIssuesOpenedEvent) => void>();
		const channel = createGitHubChannel({ webhookSecret: githubSecret });
		channel.on('issues.opened', handler);
		const body = JSON.stringify({
			action: 'opened',
			repository: {
				full_name: 'withastro/flue',
			},
			sender: {
				login: 'cpojer',
			},
			installation: {
				id: 42,
			},
			issue: {
				number: 123,
				title: 'Channels',
			},
		});

		const response = await channel.fetch(await createGitHubRequest('issues', 'delivery-1', body));

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({
			type: 'issues.opened',
			deliveryId: 'delivery-1',
			eventName: 'issues',
			action: 'opened',
			owner: 'withastro',
			repo: 'flue',
			number: 123,
			senderLogin: 'cpojer',
			installationId: 42,
		}));
	});

	it('rejects requests when the GitHub signature is invalid', async () => {
		const handler = vi.fn();
		const channel = createGitHubChannel({ webhookSecret: githubSecret });
		channel.on('issues.opened', handler);
		const body = JSON.stringify({
			action: 'opened',
			repository: {
				full_name: 'withastro/flue',
			},
			issue: {
				number: 123,
			},
		});

		const response = await channel.fetch(await createGitHubRequest('issues', 'delivery-1', body, 'sha256=bad'));

		expect(response.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('passes fetch context to lazy GitHub configuration when verifying requests', async () => {
		const handler = vi.fn();
		const channel = createGitHubChannel<{ webhookSecret: string }>({
			webhookSecret: ({ context }) => context?.webhookSecret,
		});
		channel.on('issues.opened', handler);
		const body = JSON.stringify({
			action: 'opened',
			repository: {
				full_name: 'withastro/flue',
			},
			issue: {
				number: 123,
			},
		});

		const response = await channel.fetch(
			await createGitHubRequest('issues', 'delivery-1', body),
			{ webhookSecret: githubSecret },
		);

		expect(response.status).toBe(200);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('delivers signed webhook events outside the issue and pull request helpers', async () => {
		const pushHandler = vi.fn();
		const allHandler = vi.fn();
		const channel = createGitHubChannel({ webhookSecret: githubSecret });
		channel.on('push', pushHandler);
		channel.on('*', allHandler);
		const body = JSON.stringify({
			ref: 'refs/heads/main',
			after: 'abc123',
			repository: {
				full_name: 'withastro/flue',
			},
			sender: {
				login: 'cpojer',
			},
		});

		const response = await channel.fetch(await createGitHubRequest('push', 'delivery-push', body));

		expect(response.status).toBe(200);
		expect(pushHandler).toHaveBeenCalledWith(expect.objectContaining({
			type: 'push',
			deliveryId: 'delivery-push',
			eventName: 'push',
			owner: 'withastro',
			repo: 'flue',
			payload: expect.objectContaining({
				ref: 'refs/heads/main',
			}),
		}));
		expect(allHandler).toHaveBeenCalledWith(expect.objectContaining({
			type: 'push',
			deliveryId: 'delivery-push',
		}));
	});

	it('returns a retryable status when a handler fails', async () => {
		const channel = createGitHubChannel({ webhookSecret: githubSecret });
		channel.on('issue_comment.created', async () => {
			throw new Error('dispatch unavailable');
		});
		const body = JSON.stringify({
			action: 'created',
			repository: {
				full_name: 'withastro/flue',
			},
			issue: {
				number: 123,
			},
			comment: {
				body: 'hello',
			},
		});

		const response = await channel.fetch(await createGitHubRequest('issue_comment', 'delivery-2', body));

		expect(response.status).toBe(500);
	});

	it('posts issue comments through a trusted issue tool', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1 }));
		const channel = createGitHubChannel<{ token: string }>({
			webhookSecret: githubSecret,
			token: ({ context }) => context?.token,
			fetch: fetchMock,
		});
		const tool = channel.tools.commentOnIssue(
			{ owner: 'withastro', repo: 'flue', issueNumber: 123 },
			{ token: 'gh-token' },
		);

		await expect(tool.execute({ body: 'Looks good.' })).resolves.toBe('Comment posted.');

		expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/withastro/flue/issues/123/comments', expect.objectContaining({
			method: 'POST',
			headers: expect.objectContaining({
				authorization: 'Bearer gh-token',
				'x-github-api-version': '2022-11-28',
			}),
			body: JSON.stringify({
				body: 'Looks good.',
			}),
		}));
	});

	it('round-trips GitHub conversation keys', () => {
		const channel = createGitHubChannel({ webhookSecret: githubSecret });

		const key = channel.conversationKey({ owner: 'withastro', repo: 'flue', issueNumber: 123 });

		expect(key).toBe('withastro/flue#123');
		expect(channel.parseConversationKey(key)).toEqual({ owner: 'withastro', repo: 'flue', issueNumber: 123 });
	});
});
