import type { Context, Env, Handler } from 'hono';
import { InvalidTwilioConversationKeyError, InvalidTwilioInputError } from './errors.ts';
import { createTwilioStatusCallbackHandler, createTwilioWebhookHandler } from './webhook.ts';

export { InvalidTwilioConversationKeyError, InvalidTwilioInputError } from './errors.ts';

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Fixed Twilio identity accepted by one channel. */
export type TwilioDestination =
	| {
			type: 'address';
			address: string;
	  }
	| {
			type: 'messaging-service';
			messagingServiceSid: string;
	  };

/** Ingress configuration for one Twilio account and messaging destination. */
export interface TwilioChannelOptions<E extends Env = Env> {
	/** Account SID required in every accepted message and status callback. */
	accountSid: string;
	/** Auth token used to validate the `X-Twilio-Signature` header. */
	authToken: string;
	/**
	 * Exact externally configured inbound webhook URL.
	 *
	 * Twilio signs this public URL, so it cannot be reconstructed reliably from
	 * a request after a reverse proxy. Connection-override fragments are allowed
	 * and excluded from signature validation as Twilio specifies.
	 */
	webhookUrl: string;
	/** Fixed phone/channel address or Messaging Service accepted by the channel. */
	destination: TwilioDestination;
	/** Maximum form body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives one verified inbound message webhook. */
	webhook(input: TwilioWebhookHandlerInput<E>): TwilioHandlerResult;
	/**
	 * Exact externally configured delivery-status callback URL.
	 *
	 * Required together with `statusCallback`.
	 */
	statusCallbackUrl?: string;
	/**
	 * Receives one verified outbound message status callback.
	 *
	 * Omitting this callback leaves `/status` unpublished.
	 */
	statusCallback?(input: TwilioStatusHandlerInput<E>): TwilioHandlerResult;
}

/**
 * Provider-native Twilio webhook form fields, parsed from the signed
 * `application/x-www-form-urlencoded` body.
 *
 * Twilio transmits every value as a string and repeats a name to express a
 * multi-valued field. Names use Twilio's PascalCase wire spelling. Twilio adds
 * new parameters without advance notice, so the index signature forwards any
 * authenticated field the current types do not yet model. The shape is the
 * exact verified wire object; the channel does not rename, narrow, or coerce it.
 */
export interface TwilioWebhookPayload {
	readonly [field: string]: string | readonly string[] | undefined;
}

/**
 * Provider-native inbound message webhook fields.
 *
 * Only the identity fields the channel verifies are modeled; every value is a
 * string. All other Twilio parameters — `Body`, `NumMedia`, numbered media
 * (`MediaUrl0`, `MediaContentType0`, …), geographic, rich-message, and any
 * unannounced future field — are forwarded verbatim through the index
 * signature and read directly with Twilio's PascalCase wire names.
 */
export interface TwilioIncomingMessagePayload extends TwilioWebhookPayload {
	readonly MessageSid: string;
	readonly AccountSid: string;
	readonly From: string;
	readonly To: string;
	readonly Body: string;
}

/**
 * Provider-native delivery status callback fields.
 *
 * Only the identity fields the channel verifies are modeled. `MessageStatus`
 * carries Twilio's exact lifecycle value verbatim. Every other parameter
 * (sender, recipient, error, channel, and delivery-receipt fields) is
 * forwarded through the index signature.
 */
export interface TwilioStatusCallbackPayload extends TwilioWebhookPayload {
	readonly MessageSid: string;
	readonly AccountSid: string;
	readonly MessageStatus: string;
}

/** Stable Twilio destination suitable for a Flue agent-instance id. */
export type TwilioConversationRef =
	| {
			type: 'address';
			accountSid: string;
			address: string;
			participant: string;
	  }
	| {
			type: 'messaging-service';
			accountSid: string;
			messagingServiceSid: string;
			address: string;
			participant: string;
	  };

type TwilioHandlerValue = undefined | Response;

export type TwilioHandlerResult = TwilioHandlerValue | Promise<TwilioHandlerValue>;

/** Input for one verified inbound message webhook. */
export interface TwilioWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Provider-native verified form fields with Twilio's wire names. */
	payload: TwilioIncomingMessagePayload;
	/** Canonical conversation identity derived from the verified destination and sender. */
	conversation: TwilioConversationRef;
	/** `I-Twilio-Idempotency-Token` retry identity when Twilio supplies it. */
	idempotencyToken?: string;
}

/** Input for one verified delivery status callback. */
export interface TwilioStatusHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Provider-native verified form fields with Twilio's wire names. */
	payload: TwilioStatusCallbackPayload;
	/** Canonical conversation identity when both addresses are present. */
	conversation?: TwilioConversationRef;
	/** `I-Twilio-Idempotency-Token` retry identity when Twilio supplies it. */
	idempotencyToken?: string;
}

/** Verified Twilio Messaging ingress and canonical identity helpers. */
export interface TwilioChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: TwilioConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): TwilioConversationRef;
}

/**
 * Creates verified Twilio Messaging webhook routes for one fixed destination.
 *
 * Signature validation runs over Twilio's exact configured public URL and
 * signed form fields before the handler sees them. Verified deliveries are
 * forwarded with Twilio's native field names and nesting. The channel is
 * stateless and does not deduplicate message SIDs or retry tokens.
 */
export function createTwilioChannel<E extends Env = Env>(
	options: TwilioChannelOptions<E>,
): TwilioChannel<E> {
	validateOptions(options);
	const routes: ChannelRoute<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createTwilioWebhookHandler(options),
		},
	];
	if (options.statusCallback && options.statusCallbackUrl) {
		routes.push({
			method: 'POST',
			path: '/status',
			handler: createTwilioStatusCallbackHandler(options),
		});
	}

	const channel: TwilioChannel<E> = {
		routes,
		conversationKey(ref) {
			assertConversationRef(ref);
			const base = ['twilio', 'v1', 'account', encodeURIComponent(ref.accountSid)];
			return ref.type === 'address'
				? [
						...base,
						'address',
						encodeURIComponent(ref.address),
						'participant',
						encodeURIComponent(ref.participant),
					].join(':')
				: [
						...base,
						'messaging-service',
						encodeURIComponent(ref.messagingServiceSid),
						'address',
						encodeURIComponent(ref.address),
						'participant',
						encodeURIComponent(ref.participant),
					].join(':');
		},
		parseConversationKey(id) {
			try {
				const address = /^twilio:v1:account:([^:]+):address:([^:]+):participant:([^:]+)$/.exec(id);
				const service =
					/^twilio:v1:account:([^:]+):messaging-service:([^:]+):address:([^:]+):participant:([^:]+)$/.exec(
						id,
					);
				let ref: TwilioConversationRef;
				if (address) {
					const [, accountSid, destination, participant] = address;
					if (!accountSid || !destination || !participant) {
						throw new InvalidTwilioConversationKeyError();
					}
					ref = {
						type: 'address',
						accountSid: decodeURIComponent(accountSid),
						address: decodeURIComponent(destination),
						participant: decodeURIComponent(participant),
					};
				} else if (service) {
					const [, accountSid, messagingServiceSid, destination, participant] = service;
					if (!accountSid || !messagingServiceSid || !destination || !participant) {
						throw new InvalidTwilioConversationKeyError();
					}
					ref = {
						type: 'messaging-service',
						accountSid: decodeURIComponent(accountSid),
						messagingServiceSid: decodeURIComponent(messagingServiceSid),
						address: decodeURIComponent(destination),
						participant: decodeURIComponent(participant),
					};
				} else {
					throw new InvalidTwilioConversationKeyError();
				}
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidTwilioConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidTwilioConversationKeyError) throw error;
				throw new InvalidTwilioConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: TwilioChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createTwilioChannel() requires an options object.');
	}
	assertSegment(options.accountSid, 'accountSid');
	assertSegment(options.authToken, 'authToken');
	assertConfiguredUrl(options.webhookUrl, 'webhookUrl');
	if (!options.destination || typeof options.destination !== 'object') {
		throw new InvalidTwilioInputError('destination');
	}
	if (options.destination.type === 'address') {
		assertSegment(options.destination.address, 'destination.address');
	} else if (options.destination.type === 'messaging-service') {
		assertSegment(options.destination.messagingServiceSid, 'destination.messagingServiceSid');
	} else {
		throw new InvalidTwilioInputError('destination.type');
	}
	if (typeof options.webhook !== 'function') {
		throw new InvalidTwilioInputError('webhook');
	}
	const hasStatusUrl = options.statusCallbackUrl !== undefined;
	const hasStatusHandler = options.statusCallback !== undefined;
	if (hasStatusUrl !== hasStatusHandler) {
		throw new InvalidTwilioInputError(hasStatusUrl ? 'statusCallback' : 'statusCallbackUrl');
	}
	if (options.statusCallbackUrl !== undefined) {
		assertConfiguredUrl(options.statusCallbackUrl, 'statusCallbackUrl');
	}
	if (options.statusCallback !== undefined && typeof options.statusCallback !== 'function') {
		throw new InvalidTwilioInputError('statusCallback');
	}
}

function assertConfiguredUrl(value: unknown, field: string): asserts value is string {
	assertSegment(value, field);
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		) {
			throw new InvalidTwilioInputError(field);
		}
	} catch (error) {
		if (error instanceof InvalidTwilioInputError) throw error;
		throw new InvalidTwilioInputError(field);
	}
}

function assertConversationRef(ref: TwilioConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidTwilioInputError('ref');
	assertSegment(ref.accountSid, 'conversation.accountSid');
	assertSegment(ref.address, 'conversation.address');
	assertSegment(ref.participant, 'conversation.participant');
	if (ref.type === 'address') return;
	if (ref.type === 'messaging-service') {
		assertSegment(ref.messagingServiceSid, 'conversation.messagingServiceSid');
		return;
	}
	throw new InvalidTwilioInputError('conversation.type');
}

function assertSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidTwilioInputError(field);
	}
}
