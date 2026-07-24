import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { EventPayloadMap, WebhookEventName } from '@octokit/webhooks-types';
import type { Context, Env, Hono } from 'hono';
import { InvalidGitHubInputError, InvalidGitHubInstanceIdError } from './errors.ts';
import { createGitHubWebhookHandler } from './webhook.ts';

export type { JsonValue } from '@flue/runtime';
export type { EventPayloadMap, WebhookEvent, WebhookEventName } from '@octokit/webhooks-types';
export { InvalidGitHubInputError, InvalidGitHubInstanceIdError } from './errors.ts';

/** Ingress configuration for one fixed GitHub webhook. */
export interface GitHubChannelOptions<E extends Env = Env> {
	/** Secret configured on the GitHub webhook. */
	webhookSecret: string;
	/** Maximum request-body size in bytes. Defaults to 25 MiB. */
	bodyLimit?: number;
	/** Receives every verified non-ping GitHub delivery. */
	webhook(input: GitHubWebhookHandlerInput<E>): GitHubWebhookHandlerResult;
}

/** Canonical issue or pull-request destination. Pull requests use their issue number. */
export interface GitHubIssueRef {
	owner: string;
	repo: string;
	issueNumber: number;
}

/**
 * A verified GitHub webhook delivery.
 *
 * `name` is the `X-GitHub-Event` value and discriminates `payload`, which is the
 * provider's parsed event with GitHub's own field names and nesting. The
 * remaining fields are delivery metadata read from the request headers — they
 * are identifiers, not authorization capabilities.
 */
export type GitHubWebhookDelivery = {
	[Name in WebhookEventName]: {
		/** The `X-GitHub-Event` value. Narrows the native `payload`. */
		name: Name;
		/** GitHub's parsed event payload, typed by `@octokit/webhooks-types`. */
		payload: EventPayloadMap[Name];
		/** GitHub delivery id. Manual redeliveries retain this value; use it to deduplicate. */
		deliveryId: string;
		/** Header-derived hook id, when GitHub supplies one. */
		hookId?: string;
		/** Header-derived installation target, when GitHub supplies one. */
		installationTarget?: { id: string; type: string };
	};
}[WebhookEventName];

export interface GitHubWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	delivery: GitHubWebhookDelivery;
}

type GitHubWebhookHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing produces an empty `200`. JSON-compatible values become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type GitHubWebhookHandlerResult =
	GitHubWebhookHandlerValue | Promise<GitHubWebhookHandlerValue>;

/** Verified ingress and canonical identity helpers. */
export interface GitHubChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/github', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id: a canonical namespaced identifier. It is not an authorization capability. */
	instanceId(ref: GitHubIssueRef): string;
	/**
	 * Parses only canonical instance ids produced by `instanceId()`. Escape hatch: agents
	 * normally receive structured facts as creation data rather than parsing them from the id.
	 */
	parseInstanceId(id: string): GitHubIssueRef;
}

/**
 * Creates a fixed-webhook GitHub channel.
 *
 * Requests are verified against the exact delivered bytes with `X-Hub-Signature-256`
 * before the handler runs. GitHub `ping` deliveries are answered internally. The
 * channel is stateless and does not deduplicate delivery ids: GitHub expects a
 * `2xx` within ten seconds and never auto-retries, so admit durable work quickly
 * and deduplicate on `deliveryId` when it matters.
 */
export function createGitHubChannel<E extends Env = Env>(
	options: GitHubChannelOptions<E>,
): GitHubChannel<E> {
	validateOptions(options);
	const webhookHandler = createGitHubWebhookHandler<E>({
		webhookSecret: options.webhookSecret,
		bodyLimit: options.bodyLimit,
		webhook: options.webhook,
	});

	const routes: readonly ChannelRouteDefinition<E>[] = [
		{ method: 'POST', path: '/webhook', handler: webhookHandler },
	];
	const channel: GitHubChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertIssueRef(ref);
			return `github:v1:owner:${encodeURIComponent(ref.owner)}:repo:${encodeURIComponent(ref.repo)}:issue:${ref.issueNumber}`;
		},
		parseInstanceId(id) {
			try {
				const match = /^github:v1:owner:([^:]+):repo:([^:]+):issue:([1-9]\d*)$/.exec(id);
				const owner = match?.[1];
				const repo = match?.[2];
				const issueNumberText = match?.[3];
				if (!owner || !repo || !issueNumberText) throw new InvalidGitHubInstanceIdError();
				const ref = {
					owner: decodeURIComponent(owner),
					repo: decodeURIComponent(repo),
					issueNumber: Number(issueNumberText),
				};
				assertIssueRef(ref);
				if (channel.instanceId(ref) !== id) throw new InvalidGitHubInstanceIdError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidGitHubInstanceIdError) throw error;
				throw new InvalidGitHubInstanceIdError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: GitHubChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createGitHubChannel() requires an options object.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createGitHubChannel() requires a non-empty webhookSecret.');
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createGitHubChannel() requires a webhook handler.');
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
