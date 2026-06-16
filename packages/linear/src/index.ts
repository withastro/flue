import type { LinearWebhookPayload } from '@linear/sdk/webhooks';
import type { Context, Env, Handler } from 'hono';
import { InvalidLinearConversationKeyError, InvalidLinearInputError } from './errors.ts';
import { createLinearWebhookHandler } from './webhook.ts';

/**
 * Provider-native Linear webhook payload union, re-exported from
 * `@linear/sdk/webhooks`. Verified deliveries are forwarded with Linear's own
 * field names, nesting, and `type`/`action` discriminants. The union is
 * authoritative for Linear's documented webhook surfaces and still forwards
 * unmodeled verified deliveries at runtime.
 *
 * `AgentSessionEventWebhookPayload` (the `AgentSessionEvent` member of the
 * union) and the per-entity members (`EntityWebhookPayloadWith*Data`) are
 * available directly from `@linear/sdk/webhooks` when an application narrows
 * the payload.
 */
export type { LinearWebhookPayload } from '@linear/sdk/webhooks';
export { InvalidLinearConversationKeyError, InvalidLinearInputError } from './errors.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Ingress configuration for one Linear webhook signing secret. */
export interface LinearChannelOptions<E extends Env = Env> {
	/** Secret used to verify the exact Linear request bytes. */
	webhookSecret: string;
	/** Optional fixed organization id. Mismatched signed payloads receive `403`. */
	organizationId?: string;
	/** Optional fixed webhook id. Mismatched signed payloads receive `403`. */
	webhookId?: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives every verified Linear delivery as its provider-native payload. */
	webhook(input: LinearWebhookHandlerInput<E>): LinearHandlerResult;
}

/** Stable Linear destination suitable for a Flue agent-instance id. */
export type LinearConversationRef =
	| {
			type: 'issue';
			organizationId: string;
			issueId: string;
			/** Root comment id only when the conversation is a nested comment thread. */
			threadCommentId?: string;
	  }
	| {
			type: 'agent-session';
			organizationId: string;
			agentSessionId: string;
	  };

type LinearHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing produces an empty `200`. JSON-compatible values become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type LinearHandlerResult = LinearHandlerValue | Promise<LinearHandlerValue>;

/** Input delivered to the webhook callback. */
export interface LinearWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Provider-native verified webhook payload. */
	payload: LinearWebhookPayload;
	/**
	 * `Linear-Delivery` header value: a UUID uniquely identifying this delivery,
	 * exposed for application-owned deduplication. Linear signs the body, not
	 * this transport header, and the channel does not deduplicate.
	 */
	deliveryId: string;
}

/** Verified Linear ingress and canonical identity helpers. */
export interface LinearChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: LinearConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): LinearConversationRef;
}

/**
 * Creates one verified Linear webhook route.
 *
 * Linear signs the exact raw body with HMAC-SHA256 in `Linear-Signature` and
 * includes a `webhookTimestamp` the channel requires within one minute of the
 * server clock. The channel is stateless and does not deduplicate Linear
 * delivery ids.
 */
export function createLinearChannel<E extends Env = Env>(
	options: LinearChannelOptions<E>,
): LinearChannel<E> {
	validateOptions(options);
	const channel: LinearChannel<E> = {
		routes: [
			{
				method: 'POST',
				path: '/webhook',
				handler: createLinearWebhookHandler(options),
			},
		],
		conversationKey(ref) {
			assertConversationRef(ref);
			if (ref.type === 'agent-session') {
				return [
					'linear',
					'v1',
					'organization',
					encodeURIComponent(ref.organizationId),
					'agent-session',
					encodeURIComponent(ref.agentSessionId),
				].join(':');
			}
			return [
				'linear',
				'v1',
				'organization',
				encodeURIComponent(ref.organizationId),
				'issue',
				encodeURIComponent(ref.issueId),
				'thread',
				encodeURIComponent(ref.threadCommentId ?? ''),
			].join(':');
		},
		parseConversationKey(id) {
			try {
				const agentMatch = /^linear:v1:organization:([^:]+):agent-session:([^:]+)$/.exec(id);
				if (agentMatch?.[1] && agentMatch[2]) {
					const ref: LinearConversationRef = {
						type: 'agent-session',
						organizationId: decodeURIComponent(agentMatch[1]),
						agentSessionId: decodeURIComponent(agentMatch[2]),
					};
					assertConversationRef(ref);
					if (channel.conversationKey(ref) !== id) {
						throw new InvalidLinearConversationKeyError();
					}
					return ref;
				}

				const issueMatch = /^linear:v1:organization:([^:]+):issue:([^:]+):thread:([^:]*)$/.exec(id);
				if (!issueMatch?.[1] || !issueMatch[2] || issueMatch[3] === undefined) {
					throw new InvalidLinearConversationKeyError();
				}
				const threadCommentId = decodeURIComponent(issueMatch[3]);
				const ref: LinearConversationRef = {
					type: 'issue',
					organizationId: decodeURIComponent(issueMatch[1]),
					issueId: decodeURIComponent(issueMatch[2]),
					...(threadCommentId ? { threadCommentId } : {}),
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidLinearConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidLinearConversationKeyError) throw error;
				throw new InvalidLinearConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: LinearChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createLinearChannel() requires an options object.');
	}
	if (typeof options.webhookSecret !== 'string' || options.webhookSecret.length === 0) {
		throw new TypeError('createLinearChannel() requires a non-empty webhookSecret.');
	}
	for (const field of ['organizationId', 'webhookId'] as const) {
		const value = options[field];
		if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
			throw new TypeError(`Linear ${field} must be a non-empty string when provided.`);
		}
	}
	if (typeof options.webhook !== 'function') {
		throw new TypeError('createLinearChannel() requires a webhook handler.');
	}
}

function assertConversationRef(ref: LinearConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidLinearInputError('conversation');
	if (typeof ref.organizationId !== 'string' || ref.organizationId.length === 0) {
		throw new InvalidLinearInputError('conversation.organizationId');
	}
	if (ref.type === 'agent-session') {
		if (typeof ref.agentSessionId !== 'string' || ref.agentSessionId.length === 0) {
			throw new InvalidLinearInputError('conversation.agentSessionId');
		}
		return;
	}
	if (ref.type !== 'issue') throw new InvalidLinearInputError('conversation.type');
	if (typeof ref.issueId !== 'string' || ref.issueId.length === 0) {
		throw new InvalidLinearInputError('conversation.issueId');
	}
	if (
		ref.threadCommentId !== undefined &&
		(typeof ref.threadCommentId !== 'string' || ref.threadCommentId.length === 0)
	) {
		throw new InvalidLinearInputError('conversation.threadCommentId');
	}
}
