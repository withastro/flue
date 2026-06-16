import type { Context, Env, Handler } from 'hono';
import { InvalidMessengerConversationKeyError, InvalidMessengerInputError } from './errors.ts';
import { createMessengerVerificationHandler, createMessengerWebhookHandler } from './webhook.ts';

export { InvalidMessengerConversationKeyError, InvalidMessengerInputError } from './errors.ts';

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

/** Ingress configuration for one fixed Facebook Page. */
export interface MessengerChannelOptions<E extends Env = Env> {
	/** Meta app secret used to verify exact POST request bytes. */
	appSecret: string;
	/** User-chosen token configured for Meta's GET verification handshake. */
	verifyToken: string;
	/** Expected Facebook Page id from every accepted delivery. */
	pageId: string;
	/** Maximum POST body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives one verified, provider-native delivery payload. */
	webhook(input: MessengerWebhookHandlerInput<E>): MessengerHandlerResult;
}

export type MessengerParticipantRef =
	| { type: 'page-scoped-id'; id: string }
	| { type: 'user-ref'; id: string };

/** Stable Messenger destination suitable for a Flue agent-instance id. */
export interface MessengerConversationRef {
	pageId: string;
	participant: MessengerParticipantRef;
}

/**
 * Provider-native types for the Messenger Platform Page webhook payload.
 *
 * Field names, nesting, and discriminant-by-property-presence match Meta's
 * documented wire shapes. Every modeled object also carries an index signature
 * so authenticated but unmodeled fields are forwarded at runtime rather than
 * discarded. See https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/.
 */

export interface MessengerSender {
	/** Page-scoped id (PSID). Absent when `user_ref` identifies the person. */
	id?: string;
	/** Pre-PSID reference set by Customer Matching / checkbox plugin. */
	user_ref?: string;
	[key: string]: unknown;
}

export interface MessengerRecipient {
	id?: string;
	user_ref?: string;
	[key: string]: unknown;
}

export interface MessengerAttachmentPayload {
	url?: string;
	sticker_id?: number;
	[key: string]: unknown;
}

export interface MessengerAttachment {
	type: string;
	payload?: MessengerAttachmentPayload;
	[key: string]: unknown;
}

export interface MessengerQuickReply {
	payload?: string;
	[key: string]: unknown;
}

export interface MessengerReplyTo {
	mid?: string;
	is_self_reply?: boolean;
	[key: string]: unknown;
}

export interface MessengerMessageCommand {
	name: string;
	[key: string]: unknown;
}

/** `message` object on a `messages` or `message_echoes` event. */
export interface MessengerMessage {
	mid: string;
	text?: string;
	attachments?: MessengerAttachment[];
	quick_reply?: MessengerQuickReply;
	reply_to?: MessengerReplyTo;
	referral?: MessengerReferral;
	commands?: MessengerMessageCommand[];
	/** Present and `true` on echoes of messages the Page sent. */
	is_echo?: boolean;
	/** App that sent an echoed message. */
	app_id?: number | string;
	/** Free-form metadata supplied on outbound sends, echoed back. */
	metadata?: string;
	[key: string]: unknown;
}

export interface MessengerMessageEdit {
	mid: string;
	text?: string;
	num_edit?: number;
	[key: string]: unknown;
}

export interface MessengerReferral {
	ref?: string;
	source?: string;
	type?: string;
	ad_id?: number | string;
	referer_uri?: string;
	ads_context_data?: unknown;
	[key: string]: unknown;
}

export interface MessengerPostback {
	mid?: string;
	title?: string;
	payload?: string;
	referral?: MessengerReferral;
	[key: string]: unknown;
}

export interface MessengerReaction {
	mid: string;
	action: string;
	reaction?: string;
	emoji?: string;
	[key: string]: unknown;
}

export interface MessengerDelivery {
	mids?: string[];
	watermark: number;
	[key: string]: unknown;
}

export interface MessengerRead {
	watermark: number;
	[key: string]: unknown;
}

export interface MessengerOptin {
	type?: string;
	ref?: string;
	payload?: string;
	title?: string;
	notification_messages_frequency?: string;
	notification_messages_timezone?: string;
	/**
	 * Short-lived marketing-message capability token.
	 *
	 * Never place this value in model context, dispatch input, logs, or durable
	 * session data.
	 */
	notification_messages_token?: string;
	token_expiry_timestamp?: number;
	user_token_status?: string;
	notification_messages_status?: string;
	[key: string]: unknown;
}

/**
 * One item from `entry[].messaging` or `entry[].standby`.
 *
 * The event family is discriminated by which property is present
 * (`message`, `postback`, `reaction`, …), exactly as Meta delivers it.
 * Unmodeled families still arrive intact through the index signature.
 */
export interface MessengerMessagingEvent {
	sender?: MessengerSender;
	recipient?: MessengerRecipient;
	timestamp?: number;
	message?: MessengerMessage;
	message_edit?: MessengerMessageEdit;
	postback?: MessengerPostback;
	reaction?: MessengerReaction;
	delivery?: MessengerDelivery;
	read?: MessengerRead;
	optin?: MessengerOptin;
	referral?: MessengerReferral;
	[key: string]: unknown;
}

/** One `changes` item delivered for Page-field webhook subscriptions. */
export interface MessengerChange {
	field: string;
	value: unknown;
	[key: string]: unknown;
}

/** One element of the top-level `entry` array. */
export interface MessengerEntry {
	id: string;
	time: number;
	/** Events the Page is the active receiver for. */
	messaging?: MessengerMessagingEvent[];
	/** Events received while another app owns the conversation (Handover). */
	standby?: MessengerMessagingEvent[];
	/** Page-field change notifications. */
	changes?: MessengerChange[];
	[key: string]: unknown;
}

/**
 * Provider-native Page webhook payload after exact-body verification and the
 * fixed-Page identity check.
 *
 * One signed POST may batch several entries and several events. Events stay in
 * Meta's delivered order. Flue does not reshape, filter, or deduplicate them.
 */
export interface MessengerWebhookPayload {
	object: 'page';
	entry: MessengerEntry[];
	[key: string]: unknown;
}

type MessengerHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing acknowledges with `EVENT_RECEIVED`. JSON-compatible values
 * become JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type MessengerHandlerResult = MessengerHandlerValue | Promise<MessengerHandlerValue>;

export interface MessengerWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	payload: MessengerWebhookPayload;
}

/** Verified Facebook Messenger Page ingress and canonical identity helpers. */
export interface MessengerChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: MessengerConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): MessengerConversationRef;
	/**
	 * Derives the counterpart participant for one native messaging event.
	 *
	 * Returns the person's identity (the non-Page actor) for both inbound
	 * deliveries and Page echoes, or `undefined` when the event carries no
	 * usable `sender`/`recipient` pair for this Page. The result is an
	 * identifier, not an authorization capability.
	 */
	conversationRef(event: MessengerMessagingEvent): MessengerConversationRef | undefined;
}

/**
 * Creates verified Facebook Messenger webhook routes for one fixed Page.
 *
 * The channel verifies Meta's GET handshake and exact-body
 * `X-Hub-Signature-256` HMAC, confirms each entry targets the configured Page,
 * and forwards the provider-native payload unchanged. It is stateless and does
 * not deduplicate messages or deliveries.
 */
export function createMessengerChannel<E extends Env = Env>(
	options: MessengerChannelOptions<E>,
): MessengerChannel<E> {
	validateOptions(options);
	const pageId = options.pageId;
	const channel: MessengerChannel<E> = {
		routes: [
			{
				method: 'GET',
				path: '/webhook',
				handler: createMessengerVerificationHandler(options),
			},
			{
				method: 'POST',
				path: '/webhook',
				handler: createMessengerWebhookHandler(options),
			},
		],
		conversationKey(ref) {
			assertConversationRef(ref);
			return [
				'messenger',
				'v1',
				'page',
				encodeURIComponent(ref.pageId),
				ref.participant.type,
				encodeURIComponent(ref.participant.id),
			].join(':');
		},
		parseConversationKey(id) {
			try {
				const match = /^messenger:v1:page:([^:]+):(page-scoped-id|user-ref):([^:]+)$/.exec(id);
				if (!match) throw new InvalidMessengerConversationKeyError();
				const [, encodedPageId, type, participantId] = match;
				if (!encodedPageId || !type || !participantId) {
					throw new InvalidMessengerConversationKeyError();
				}
				const ref: MessengerConversationRef = {
					pageId: decodeURIComponent(encodedPageId),
					participant: {
						type: type as MessengerParticipantRef['type'],
						id: decodeURIComponent(participantId),
					},
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidMessengerConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidMessengerConversationKeyError) throw error;
				throw new InvalidMessengerConversationKeyError();
			}
		},
		conversationRef(event) {
			const sender = participantActor(event.sender, pageId);
			const recipient = participantActor(event.recipient, pageId);
			if (sender?.type === 'page' && recipient && recipient.type !== 'page') {
				return { pageId, participant: recipient };
			}
			if (recipient?.type === 'page' && sender && sender.type !== 'page') {
				return { pageId, participant: sender };
			}
			return undefined;
		},
	};
	return channel;
}

type MessengerActor = { type: 'page'; id: string } | MessengerParticipantRef;

function participantActor(
	actor: { id?: string; user_ref?: string } | undefined,
	pageId: string,
): MessengerActor | undefined {
	if (!actor || typeof actor !== 'object') return undefined;
	const id = typeof actor.id === 'string' && actor.id.length > 0 ? actor.id : undefined;
	const userRef =
		typeof actor.user_ref === 'string' && actor.user_ref.length > 0 ? actor.user_ref : undefined;
	if (id !== undefined && userRef !== undefined) return undefined;
	if (id !== undefined) {
		return id === pageId ? { type: 'page', id } : { type: 'page-scoped-id', id };
	}
	if (userRef !== undefined) return { type: 'user-ref', id: userRef };
	return undefined;
}

function validateOptions<E extends Env>(options: MessengerChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createMessengerChannel() requires an options object.');
	}
	assertSegment(options.appSecret, 'appSecret');
	assertSegment(options.verifyToken, 'verifyToken');
	assertSegment(options.pageId, 'pageId');
	if (typeof options.webhook !== 'function') {
		throw new InvalidMessengerInputError('webhook');
	}
}

function assertConversationRef(ref: MessengerConversationRef): void {
	if (!ref || typeof ref !== 'object') {
		throw new InvalidMessengerInputError('conversation');
	}
	assertSegment(ref.pageId, 'conversation.pageId');
	if (!ref.participant || typeof ref.participant !== 'object') {
		throw new InvalidMessengerInputError('conversation.participant');
	}
	if (ref.participant.type !== 'page-scoped-id' && ref.participant.type !== 'user-ref') {
		throw new InvalidMessengerInputError('conversation.participant.type');
	}
	assertSegment(ref.participant.id, 'conversation.participant.id');
}

function assertSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidMessengerInputError(field);
	}
}
