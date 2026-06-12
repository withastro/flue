import { Type, defineTool, type ToolDefinition } from '@flue/runtime';
import type { Channel, LazyValue, MaybePromise } from './index.ts';
import { resolveLazyValue, verifyHmacSha256Signature } from './index.ts';

type GitHubHandler<TEvent> = (event: TEvent) => MaybePromise<void>;

export interface GitHubChannelOptions<TContext = unknown> {
	/** GitHub webhook secret. Resolved lazily on inbound requests. */
	readonly webhookSecret: LazyValue<string, GitHubRequestContext<TContext>>;
	/** GitHub token. Resolved lazily only when client or tool calls need it. */
	readonly token?: LazyValue<string, GitHubRequestContext<TContext>>;
	/** Override for tests or GitHub Enterprise. Defaults to `https://api.github.com`. */
	readonly apiBaseUrl?: string;
	/** Override for tests or custom runtimes. Defaults to global `fetch`. */
	readonly fetch?: typeof fetch;
}

export interface GitHubRequestContext<TContext = unknown> {
	readonly request: Request;
	readonly context?: TContext;
}

export interface GitHubIssueRef {
	readonly owner: string;
	readonly repo: string;
	readonly issueNumber: number;
}

export interface GitHubEventBase {
	readonly deliveryId: string;
	readonly eventName: string;
	readonly type: string;
	readonly action?: string;
	readonly owner?: string;
	readonly repo?: string;
	readonly repository?: GitHubRepositoryPayload;
	readonly senderLogin?: string;
	readonly installationId?: number;
	readonly raw: unknown;
}

export interface GitHubWebhookEvent extends GitHubEventBase {
	readonly payload: GitHubWebhookPayload;
}

export interface GitHubIssueThreadEventBase extends GitHubWebhookEvent {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

export interface GitHubIssuesOpenedEvent extends GitHubIssueThreadEventBase {
	readonly type: 'issues.opened';
	readonly action: 'opened';
	readonly issue: GitHubIssuePayload;
}

export interface GitHubIssueCommentCreatedEvent extends GitHubIssueThreadEventBase {
	readonly type: 'issue_comment.created';
	readonly action: 'created';
	readonly comment: GitHubCommentPayload;
	readonly issue: GitHubIssuePayload;
}

export interface GitHubPullRequestOpenedEvent extends GitHubIssueThreadEventBase {
	readonly type: 'pull_request.opened';
	readonly action: 'opened';
	readonly pullRequest: GitHubPullRequestPayload;
}

export interface GitHubPullRequestReviewCommentCreatedEvent extends GitHubIssueThreadEventBase {
	readonly type: 'pull_request_review_comment.created';
	readonly action: 'created';
	readonly comment: GitHubCommentPayload;
}

export type GitHubChannelEvent =
	| GitHubIssueCommentCreatedEvent
	| GitHubIssuesOpenedEvent
	| GitHubPullRequestOpenedEvent
	| GitHubPullRequestReviewCommentCreatedEvent;

export type GitHubAnyWebhookEvent = GitHubChannelEvent | GitHubWebhookEvent;

export interface GitHubClient<TContext = unknown> {
	createIssueComment(input: GitHubCreateIssueCommentInput, context?: TContext): Promise<GitHubApiResponse>;
	addLabels(input: GitHubAddLabelsInput, context?: TContext): Promise<GitHubApiResponse>;
	api<T = GitHubApiResponse>(method: string, path: string, body?: unknown, context?: TContext): Promise<T>;
}

export interface GitHubTools<TContext = unknown> {
	commentOnIssue(ref: GitHubIssueRef, context?: TContext): ToolDefinition;
	addLabels(ref: GitHubIssueRef, context?: TContext): ToolDefinition;
}

export interface GitHubChannel<TContext = unknown> extends Channel<TContext> {
	on(type: '*', handler: GitHubHandler<GitHubAnyWebhookEvent>): () => void;
	on(type: 'issue_comment.created', handler: GitHubHandler<GitHubIssueCommentCreatedEvent>): () => void;
	on(type: 'issues.opened', handler: GitHubHandler<GitHubIssuesOpenedEvent>): () => void;
	on(type: 'pull_request.opened', handler: GitHubHandler<GitHubPullRequestOpenedEvent>): () => void;
	on(
		type: 'pull_request_review_comment.created',
		handler: GitHubHandler<GitHubPullRequestReviewCommentCreatedEvent>,
	): () => void;
	on(type: string, handler: GitHubHandler<GitHubAnyWebhookEvent>): () => void;
	conversationKey(event: GitHubIssueRef): string;
	parseConversationKey(key: string): GitHubIssueRef;
	readonly client: GitHubClient<TContext>;
	readonly tools: GitHubTools<TContext>;
}

export interface GitHubCreateIssueCommentInput extends GitHubIssueRef {
	readonly body: string;
}

export interface GitHubAddLabelsInput extends GitHubIssueRef {
	readonly labels: ReadonlyArray<string>;
}

export interface GitHubApiResponse {
	readonly [key: string]: unknown;
}

export interface GitHubRepositoryPayload {
	readonly name?: string;
	readonly full_name?: string;
	readonly owner?: {
		readonly login?: string;
	};
}

export interface GitHubIssuePayload {
	readonly number?: number;
	readonly title?: string;
	readonly body?: string | null;
	readonly html_url?: string;
}

export interface GitHubPullRequestPayload {
	readonly number?: number;
	readonly title?: string;
	readonly body?: string | null;
	readonly html_url?: string;
}

export interface GitHubCommentPayload {
	readonly id?: number;
	readonly body?: string;
	readonly html_url?: string;
	readonly pull_request_url?: string;
}

export interface GitHubWebhookPayload {
	readonly action?: string;
	readonly repository?: GitHubRepositoryPayload;
	readonly sender?: {
		readonly login?: string;
	};
	readonly installation?: {
		readonly id?: number;
	};
	readonly issue?: GitHubIssuePayload;
	readonly pull_request?: GitHubPullRequestPayload;
	readonly comment?: GitHubCommentPayload;
	readonly [key: string]: unknown;
}

export function createGitHubChannel<TContext = unknown>(options: GitHubChannelOptions<TContext>): GitHubChannel<TContext> {
	const handlers = new Map<string, Set<GitHubHandler<GitHubAnyWebhookEvent>>>();
	const fetchImpl = options.fetch ?? fetch;
	const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';

	const channel: GitHubChannel = {
		async fetch(request: Request, context?: TContext) {
			if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
			const body = await request.text();
			const secret = await resolveLazyValue(options.webhookSecret, { request, context }, 'GitHub webhook secret');
			const verification = await verifyHmacSha256Signature({
				secret,
				message: body,
				signature: request.headers.get('x-hub-signature-256'),
				prefix: 'sha256=',
			});
			if (!verification.ok) return new Response('invalid signature', { status: 401 });
			return handleGitHubRequest(body, request, handlers).catch(toGitHubHandlerFailure);
		},
		on(type, handler) {
			let set = handlers.get(type);
			if (!set) {
				set = new Set();
				handlers.set(type, set);
			}
			set.add(handler as GitHubHandler<GitHubAnyWebhookEvent>);
			return () => {
				set.delete(handler as GitHubHandler<GitHubAnyWebhookEvent>);
				if (set.size === 0) handlers.delete(type);
			};
		},
		conversationKey(ref) {
			return `${ref.owner}/${ref.repo}#${ref.issueNumber}`;
		},
		parseConversationKey(key) {
			const match = /^(?<owner>[^/]+)\/(?<repo>[^#]+)#(?<issueNumber>\d+)$/.exec(key);
			if (!match?.groups) {
				throw new Error(`[flue:channels:github] Invalid GitHub conversation key "${key}".`);
			}
			return {
				owner: match.groups.owner!,
				repo: match.groups.repo!,
				issueNumber: Number(match.groups.issueNumber),
			};
		},
		client: {
			createIssueComment(input, context?: TContext) {
				return githubApiCall(fetchImpl, options, apiBaseUrl, 'POST', `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments`, {
					body: input.body,
				}, context);
			},
			addLabels(input, context?: TContext) {
				return githubApiCall(fetchImpl, options, apiBaseUrl, 'POST', `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/labels`, {
					labels: input.labels,
				}, context);
			},
			api(method, path, body, context?: TContext) {
				return githubApiCall(fetchImpl, options, apiBaseUrl, method, path, body, context);
			},
		},
		tools: {
			commentOnIssue(ref, context?: TContext) {
				return defineTool({
					name: 'comment_on_github_issue',
					description: 'Comment on the trusted GitHub issue or pull request selected by the application.',
					parameters: Type.Object({
						body: Type.String(),
					}),
					execute: async ({ body }) => {
						await channel.client.createIssueComment({ ...ref, body }, context);
						return 'Comment posted.';
					},
				});
			},
			addLabels(ref, context?: TContext) {
				return defineTool({
					name: 'add_github_labels',
					description: 'Add labels to the trusted GitHub issue or pull request selected by the application.',
					parameters: Type.Object({
						labels: Type.Array(Type.String()),
					}),
					execute: async ({ labels }) => {
						await channel.client.addLabels({ ...ref, labels }, context);
						return 'Labels added.';
					},
				});
			},
		},
	};

	return channel;
}

async function handleGitHubRequest(
	body: string,
	request: Request,
	handlers: Map<string, Set<GitHubHandler<GitHubAnyWebhookEvent>>>,
): Promise<Response> {
	const eventName = request.headers.get('x-github-event');
	const deliveryId = request.headers.get('x-github-delivery');
	if (!eventName || !deliveryId) return Response.json({ ok: true });
	const payload = JSON.parse(body) as GitHubWebhookPayload;
	const event = normalizeGitHubEvent(eventName, deliveryId, payload);
	await dispatchGitHubHandlers(handlers.get(event.type), event);
	await dispatchGitHubHandlers(handlers.get('*'), event);
	return Response.json({ ok: true });
}

function normalizeGitHubEvent(
	eventName: string,
	deliveryId: string,
	payload: GitHubWebhookPayload,
): GitHubAnyWebhookEvent {
	const repository = parseRepository(payload.repository);
	const base = {
		deliveryId,
		eventName,
		type: eventType(eventName, payload.action),
		action: payload.action,
		owner: repository?.owner,
		repo: repository?.repo,
		repository: payload.repository,
		senderLogin: payload.sender?.login,
		installationId: payload.installation?.id,
		payload,
		raw: payload,
	};

	if (repository && eventName === 'issues' && payload.action === 'opened' && payload.issue?.number) {
		return {
			...base,
			type: 'issues.opened',
			action: 'opened',
			owner: repository.owner,
			repo: repository.repo,
			number: payload.issue.number,
			issue: payload.issue,
		};
	}

	if (repository && eventName === 'issue_comment' && payload.action === 'created' && payload.issue?.number && payload.comment) {
		return {
			...base,
			type: 'issue_comment.created',
			action: 'created',
			owner: repository.owner,
			repo: repository.repo,
			number: payload.issue.number,
			issue: payload.issue,
			comment: payload.comment,
		};
	}

	if (repository && eventName === 'pull_request' && payload.action === 'opened' && payload.pull_request?.number) {
		return {
			...base,
			type: 'pull_request.opened',
			action: 'opened',
			owner: repository.owner,
			repo: repository.repo,
			number: payload.pull_request.number,
			pullRequest: payload.pull_request,
		};
	}

	if (repository && eventName === 'pull_request_review_comment' && payload.action === 'created' && payload.comment) {
		const number = extractPullRequestNumber(payload);
		if (number) {
			return {
				...base,
				type: 'pull_request_review_comment.created',
				action: 'created',
				owner: repository.owner,
				repo: repository.repo,
				number,
				comment: payload.comment,
			};
		}
	}

	return base;
}

function eventType(eventName: string, action: string | undefined): string {
	return action ? `${eventName}.${action}` : eventName;
}

function parseRepository(repository: GitHubRepositoryPayload | undefined): { owner: string; repo: string } | null {
	if (!repository) return null;
	if (repository.full_name?.includes('/')) {
		const [owner, repo, extra] = repository.full_name.split('/');
		if (owner && repo && extra === undefined) return { owner, repo };
	}
	if (repository.owner?.login && repository.name) {
		return { owner: repository.owner.login, repo: repository.name };
	}
	return null;
}

function extractPullRequestNumber(payload: GitHubWebhookPayload): number | undefined {
	if (payload.pull_request?.number) return payload.pull_request.number;
	const url = payload.comment?.pull_request_url;
	if (!url) return undefined;
	const lastSegment = url.split('/').pop();
	if (!lastSegment) return undefined;
	const number = Number(lastSegment);
	return Number.isInteger(number) ? number : undefined;
}

async function dispatchGitHubHandlers(
	handlers: Set<GitHubHandler<GitHubAnyWebhookEvent>> | undefined,
	event: GitHubAnyWebhookEvent,
): Promise<void> {
	for (const handler of handlers ?? []) {
		await handler(event);
	}
}

function toGitHubHandlerFailure(error: unknown): Response {
	console.error('[flue:channels:github] Handler failed.', error);
	return new Response('handler failed', { status: 500 });
}

async function githubApiCall<T, TContext>(
	fetchImpl: typeof fetch,
	options: GitHubChannelOptions<TContext>,
	apiBaseUrl: string,
	method: string,
	path: string,
	body?: unknown,
	context?: TContext,
): Promise<T> {
	const token = await resolveLazyValue(options.token, { request: new Request('https://github.local/tool'), context }, 'GitHub token');
	const response = await fetchImpl(`${apiBaseUrl}${path}`, {
		method,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'x-github-api-version': '2022-11-28',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const json = parseGitHubApiResponse(text);
	if (!response.ok) {
		const message = typeof json.message === 'string' ? json.message : (text || response.statusText);
		throw new Error(`[flue:channels:github] GitHub API ${method} ${path} failed: ${message}`);
	}
	return json as T;
}

function parseGitHubApiResponse(text: string): GitHubApiResponse {
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as GitHubApiResponse;
	} catch {
		return { text };
	}
}
