import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const baseUrl = process.env.FLUE_CHAT_BASE_URL ?? 'http://localhost:3585';
const runId = Date.now();
const issueNumber = runId;
const mentionPayload = issueCommentPayload({
	body: '@flue-bot please reply',
	id: runId,
});
const approvalPayload = issueCommentPayload({
	body: 'approve',
	id: runId + 1,
});

const mentionResponse = await sendWebhookWhenReady(mentionPayload);
assert.equal(mentionResponse.status, 200);
assert.equal(await mentionResponse.text(), 'ok');

const firstComments = await waitForOutboundComments(1);
assert.deepEqual(firstComments, [
	{
		issueNumber,
		body: 'I need human approval before continuing. Reply with "approve" in this thread.',
	},
]);

const approvalResponse = await sendWebhookWhenReady(approvalPayload);
assert.equal(approvalResponse.status, 200);
assert.equal(await approvalResponse.text(), 'ok');

const comments = await waitForOutboundComments(2);
assert.deepEqual(comments, [
	{
		issueNumber,
		body: 'I need human approval before continuing. Reply with "approve" in this thread.',
	},
	{
		issueNumber,
		body: 'Approved by a human. Reply from a Flue agent through Chat SDK.',
	},
]);

function issueCommentPayload({ body, id }) {
	return {
		action: 'created',
		comment: {
			id,
			body,
			created_at: '2026-05-25T00:00:00.000Z',
			updated_at: '2026-05-25T00:00:00.000Z',
			user: { id: 2, login: 'octocat', type: 'User' },
		},
		issue: { number: issueNumber },
		repository: { name: 'widgets', owner: { id: 3, login: 'acme', type: 'Organization' } },
		sender: { id: 2, login: 'octocat', type: 'User' },
	};
}

async function sendWebhookWhenReady(payload) {
	const body = JSON.stringify(payload);
	const signature = `sha256=${createHmac('sha256', 'chat-sdk-example-secret').update(body).digest('hex')}`;
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		try {
			return await fetch(new URL('/webhooks/github', baseUrl), {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-github-event': 'issue_comment',
					'x-hub-signature-256': signature,
				},
				body,
			});
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error('Timed out waiting for the Flue server.');
}

async function waitForOutboundComments(count) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const result = await fetch(new URL('/test/outbound-comments', baseUrl));
		if (result.ok) {
			const comments = await result.json();
			const runComments = comments.filter((comment) => comment.issueNumber === issueNumber);
			if (runComments.length >= count) return runComments;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Timed out waiting for the Chat SDK outbound comment.');
}
