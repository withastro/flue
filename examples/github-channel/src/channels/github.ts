import { createGitHubChannel } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new Octokit({
	auth: requiredEnv('GITHUB_TOKEN'),
});

export const channel = createGitHubChannel({
	webhookSecret: requiredEnv('GITHUB_WEBHOOK_SECRET'),

	// Path: /channels/github/webhook
	async webhook({ delivery }) {
		if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
			const { repository, issue, comment, sender, installation } = delivery.payload;
			const issueRef = {
				owner: repository.owner.login,
				repo: repository.name,
				issueNumber: issue.number,
			};
			await dispatch(Assistant, {
				id: channel.instanceId(issueRef),
				// Recorded once when this event creates the instance; ignored after.
				initialData: {
					owner: issueRef.owner,
					repo: issueRef.repo,
					issueNumber: issueRef.issueNumber,
					openedBy: issue.user.login,
					title: issue.title,
				},
				message: {
					kind: 'signal',
					type: 'github.issue_comment.created',
					body: comment.body,
					attributes: {
						deliveryId: delivery.deliveryId,
						...(installation === undefined ? {} : { installationId: String(installation.id) }),
						owner: issueRef.owner,
						repo: issueRef.repo,
						issueNumber: String(issueRef.issueNumber),
						sender: sender.login,
						title: issue.title,
						commentId: String(comment.id),
					},
				},
			});
			return;
		}

		if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
			const { repository, pull_request, comment, sender, installation } = delivery.payload;
			const issueRef = {
				owner: repository.owner.login,
				repo: repository.name,
				issueNumber: pull_request.number,
			};
			await dispatch(Assistant, {
				id: channel.instanceId(issueRef),
				// Recorded once when this event creates the instance; ignored after.
				initialData: {
					owner: issueRef.owner,
					repo: issueRef.repo,
					issueNumber: issueRef.issueNumber,
					openedBy: pull_request.user.login,
					title: pull_request.title,
				},
				message: {
					kind: 'signal',
					type: 'github.pull_request_review_comment.created',
					body: comment.body,
					attributes: {
						deliveryId: delivery.deliveryId,
						...(installation === undefined ? {} : { installationId: String(installation.id) }),
						owner: issueRef.owner,
						repo: issueRef.repo,
						issueNumber: String(issueRef.issueNumber),
						sender: sender.login,
						title: pull_request.title,
						commentId: String(comment.id),
						// GitHub replies attach to the top-level review comment in a thread.
						threadId: String(comment.in_reply_to_id ?? comment.id),
						path: comment.path,
						...(comment.line === null || comment.line === undefined
							? {}
							: { line: String(comment.line) }),
					},
				},
			});
			return;
		}
	},
});

export function commentOnIssue(ref: { owner: string; repo: string; issueNumber: number }) {
	return defineTool({
		name: 'comment_on_github_issue',
		description: 'Post a comment to the GitHub issue or pull request bound to this agent.',
		input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const result = await client.rest.issues.createComment({
				owner: ref.owner,
				repo: ref.repo,
				issue_number: ref.issueNumber,
				body: data.body,
			});
			return { commentId: result.data.id, url: result.data.html_url };
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
