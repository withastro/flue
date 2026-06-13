import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import { createGitHubClient } from './client.ts';
import {
	DuplicateGitHubHandlerError,
	InvalidGitHubConversationKeyError,
	InvalidGitHubInputError,
} from './errors.ts';
import { createGitHubWebhookHandler } from './webhook.ts';

export type { GitHubRateLimit } from './errors.ts';
export {
	DuplicateGitHubHandlerError,
	GitHubApiError,
	GitHubRateLimitError,
	GitHubTimeoutError,
	InvalidGitHubConversationKeyError,
	InvalidGitHubInputError,
} from './errors.ts';

/** Credentials and transport settings for one fixed GitHub integration. */
export interface GitHubChannelOptions {
	/** Secret configured on the GitHub webhook. */
	webhookSecret: string;
	/** Token used for issue and pull-request API writes. */
	token: string;
	/** Fetch implementation used by the outbound client. Defaults to `globalThis.fetch`. */
	fetch?: typeof globalThis.fetch;
	/** Outbound request timeout in milliseconds. Defaults to 10 seconds. */
	requestTimeoutMs?: number;
}

/** Canonical issue or pull-request destination. Pull requests use their issue number. */
export interface GitHubIssueRef {
	owner: string;
	repo: string;
	issueNumber: number;
}

export interface GitHubRepositoryRef {
	id: number;
	owner: string;
	name: string;
}

export interface GitHubIssuesOpenedPayload {
	issue: { number: number; title: string; body: string | null };
}

export interface GitHubIssueCommentCreatedPayload {
	issue: { number: number };
	comment: { id: number; body: string };
}

export interface GitHubPullRequestOpenedPayload {
	pullRequest: { number: number; title: string; body: string | null };
}

export interface GitHubWebhookEvent<TType extends string, TPayload> {
	type: TType;
	/** GitHub delivery id. Replays and manual redeliveries retain this value. */
	deliveryId: string;
	hookId?: string;
	installationTarget?: {
		id: string;
		type: string;
	};
	installationId?: number;
	repository: GitHubRepositoryRef;
	payload: TPayload;
	/** Parsed provider payload. Treat this as untrusted provider data. */
	raw: unknown;
}

export interface GitHubEvents {
	'issues.opened': GitHubWebhookEvent<'issues.opened', GitHubIssuesOpenedPayload>;
	'issue_comment.created': GitHubWebhookEvent<
		'issue_comment.created',
		GitHubIssueCommentCreatedPayload
	>;
	'pull_request.opened': GitHubWebhookEvent<
		'pull_request.opened',
		GitHubPullRequestOpenedPayload
	>;
}

export type GitHubEventName = keyof GitHubEvents;
export type GitHubNotificationHandler<TEvent> = (event: TEvent) => void | Promise<void>;
export type GitHubRouteHandler = (request: Request) => Promise<Response>;

export interface GitHubWebhookRouteOptions {
	/** Maximum request-body size in bytes. Defaults to 25 MiB. */
	bodyLimit?: number;
}

/** Fixed-origin GitHub REST writes. Methods do not retry automatically. */
export interface GitHubClient {
	commentOnIssue(ref: GitHubIssueRef, text: string, signal?: AbortSignal): Promise<void>;
	addLabels(ref: GitHubIssueRef, labels: string[], signal?: AbortSignal): Promise<void>;
}

/** Verified ingress, outbound client/tools, and canonical identity helpers. */
export interface GitHubChannel {
	readonly routes: {
		webhook(options?: GitHubWebhookRouteOptions): GitHubRouteHandler;
	};
	readonly client: GitHubClient;
	readonly tools: {
		commentOnIssue(ref: GitHubIssueRef): ToolDefinition;
		addLabels(ref: GitHubIssueRef): ToolDefinition;
	};
	/**
	 * Registers the sole handler for one supported event key.
	 *
	 * The returned unsubscribe function is registration-specific and idempotent.
	 */
	on<TKey extends GitHubEventName>(
		type: TKey,
		handler: GitHubNotificationHandler<GitHubEvents[TKey]>,
	): () => void;
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: GitHubIssueRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): GitHubIssueRef;
}

/**
 * Creates a fixed-credential GitHub channel.
 *
 * Successful webhook acknowledgement waits for the registered handler to
 * finish. The channel is stateless and does not deduplicate delivery ids.
 */
export function createGitHubChannel(options: GitHubChannelOptions): GitHubChannel {
	validateOptions(options);
	const webhookSecret = options.webhookSecret;
	const clientOptions = {
		webhookSecret,
		token: options.token,
		fetch: options.fetch,
		requestTimeoutMs: options.requestTimeoutMs,
	};
	const handlers = new Map<
		GitHubEventName,
		GitHubNotificationHandler<GitHubEvents[GitHubEventName]>
	>();
	const client = createGitHubClient(clientOptions);

	const channel: GitHubChannel = {
		routes: {
				webhook: (routeOptions) =>
					createGitHubWebhookHandler({
						webhookSecret,
					bodyLimit: routeOptions?.bodyLimit,
					getHandler: (type) => handlers.get(type),
				}),
		},
		client,
		tools: {
			commentOnIssue: (ref) => {
				assertIssueRef(ref);
				const boundRef = snapshotIssueRef(ref);
				return defineTool({
					name: 'github_comment_on_issue',
					description: 'Post a comment to the bound GitHub issue or pull request.',
					parameters: {
						type: 'object',
						properties: { text: { type: 'string', minLength: 1 } },
						required: ['text'],
						additionalProperties: false,
					},
					execute: async ({ text }, signal) => {
						await client.commentOnIssue(boundRef, text, signal);
						return 'Comment posted.';
					},
				});
			},
			addLabels: (ref) => {
				assertIssueRef(ref);
				const boundRef = snapshotIssueRef(ref);
				return defineTool({
					name: 'github_add_labels',
					description: 'Add labels to the bound GitHub issue or pull request.',
					parameters: {
						type: 'object',
						properties: {
							labels: {
								type: 'array',
								items: { type: 'string', minLength: 1 },
								minItems: 1,
							},
						},
						required: ['labels'],
						additionalProperties: false,
					},
					execute: async ({ labels }, signal) => {
						await client.addLabels(boundRef, labels, signal);
						return 'Labels added.';
					},
				});
			},
		},
		on(type, handler) {
			if (typeof handler !== 'function') {
				throw new TypeError(`GitHub handler for "${type}" must be a function.`);
			}
			if (handlers.has(type)) {
				throw new DuplicateGitHubHandlerError(type);
			}
			const registeredHandler =
				handler as GitHubNotificationHandler<GitHubEvents[GitHubEventName]>;
			handlers.set(type, registeredHandler);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (handlers.get(type) === registeredHandler) handlers.delete(type);
			};
		},
		conversationKey(ref) {
			assertIssueRef(ref);
			return `github:v1:owner:${encodeURIComponent(ref.owner)}:repo:${encodeURIComponent(ref.repo)}:issue:${ref.issueNumber}`;
		},
		parseConversationKey(id) {
			try {
				const match = /^github:v1:owner:([^:]+):repo:([^:]+):issue:([1-9]\d*)$/.exec(id);
				const owner = match?.[1];
				const repo = match?.[2];
				const issueNumberText = match?.[3];
				if (!owner || !repo || !issueNumberText) throw new InvalidGitHubConversationKeyError();
				const ref = {
					owner: decodeURIComponent(owner),
					repo: decodeURIComponent(repo),
					issueNumber: Number(issueNumberText),
				};
				assertIssueRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidGitHubConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidGitHubConversationKeyError) throw error;
				throw new InvalidGitHubConversationKeyError();
			}
		},
	};

	return channel;
}

function validateOptions(options: GitHubChannelOptions): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createGitHubChannel() requires an options object.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createGitHubChannel() requires a non-empty webhookSecret.');
	}
	if (typeof options.token !== 'string' || options.token.length === 0) {
		throw new TypeError('createGitHubChannel() requires a non-empty token.');
	}
	if (options.fetch !== undefined && typeof options.fetch !== 'function') {
		throw new TypeError('createGitHubChannel() fetch must be a function.');
	}
	if (
		options.requestTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
	) {
		throw new TypeError('createGitHubChannel() requestTimeoutMs must be a positive integer.');
	}
}

function assertIssueRef(ref: GitHubIssueRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidGitHubInputError('ref');
	assertPathSegment(ref.owner, 'owner');
	assertPathSegment(ref.repo, 'repo');
	if (!Number.isSafeInteger(ref.issueNumber) || ref.issueNumber <= 0) {
		throw new InvalidGitHubInputError('issueNumber');
	}
}

function assertPathSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidGitHubInputError(field);
	}
}

function snapshotIssueRef(ref: GitHubIssueRef): GitHubIssueRef {
	return {
		owner: ref.owner,
		repo: ref.repo,
		issueNumber: ref.issueNumber,
	};
}
