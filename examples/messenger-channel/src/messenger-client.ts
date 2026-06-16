import type { MessengerParticipantRef } from '@flue/messenger';

type MessengerJsonValue =
	| null
	| boolean
	| number
	| string
	| MessengerJsonValue[]
	| { [key: string]: MessengerJsonValue };

export interface MessengerClientOptions {
	pageId: string;
	pageAccessToken: string;
	graphVersion?: string;
	fetch?: typeof globalThis.fetch;
	apiBaseUrl?: string;
}

export interface MessengerRequestOptions {
	method?: 'GET' | 'POST' | 'DELETE';
	query?: Record<string, string | number | boolean | undefined>;
	body?: MessengerJsonValue;
}

export interface MessengerSendInput {
	to: MessengerParticipantRef;
	message: { [key: string]: MessengerJsonValue };
	messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';
	tag?: string;
	notificationType?: 'REGULAR' | 'SILENT_PUSH' | 'NO_PUSH';
	replyToMessageId?: string;
}

export interface MessengerSendTextInput {
	to: MessengerParticipantRef;
	text: string;
	messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';
	tag?: string;
	replyToMessageId?: string;
}

export type MessengerSenderAction =
	| { type: 'mark_seen' | 'typing_on' | 'typing_off' }
	| {
			type: 'react';
			messageId: string;
			reaction: string;
	  }
	| {
			type: 'unreact';
			messageId: string;
	  };

export interface MessengerSendResult {
	recipientId: string;
	messageId?: string;
}

export class MessengerClient {
	readonly messages: {
		send(input: MessengerSendInput): Promise<MessengerSendResult>;
		sendText(input: MessengerSendTextInput): Promise<MessengerSendResult>;
	};

	readonly senderActions: {
		send(
			to: MessengerParticipantRef,
			action: MessengerSenderAction,
		): Promise<{ recipientId: string }>;
	};

	readonly #pageId: string;
	readonly #pageAccessToken: string;
	readonly #graphVersion: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #apiBaseUrl: string;

	constructor(options: MessengerClientOptions) {
		this.#pageId = required(options.pageId, 'pageId');
		this.#pageAccessToken = required(options.pageAccessToken, 'pageAccessToken');
		this.#graphVersion = options.graphVersion ?? 'v25.0';
		if (!/^v\d+\.\d+$/.test(this.#graphVersion)) {
			throw new TypeError('Messenger graphVersion must look like v25.0.');
		}
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
		this.messages = {
			send: (input) => this.#sendMessage(input),
			sendText: (input) =>
				this.#sendMessage({
					to: input.to,
					message: {
						text: required(input.text, 'text'),
					},
					...(input.messagingType === undefined ? {} : { messagingType: input.messagingType }),
					...(input.tag === undefined ? {} : { tag: input.tag }),
					...(input.replyToMessageId === undefined
						? {}
						: { replyToMessageId: input.replyToMessageId }),
				}),
		};
		this.senderActions = {
			send: (to, action) => this.#sendAction(to, action),
		};
	}

	async request<T>(path: string, options: MessengerRequestOptions = {}): Promise<T> {
		if (!path.startsWith('/')) {
			throw new TypeError('Messenger request path must start with /.');
		}
		const url = new URL(`${this.#apiBaseUrl}${path}`);
		url.searchParams.set('access_token', this.#pageAccessToken);
		for (const [name, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(name, String(value));
		}
		const result = await this.#fetch(url, {
			method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
			headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const payload = await readJson(result);
		if (!result.ok) {
			const error = isRecord(payload.error) ? payload.error : undefined;
			const detail =
				error && typeof error.message === 'string'
					? error.message
					: `Messenger request failed with status ${result.status}.`;
			throw new Error(detail);
		}
		return payload as T;
	}

	async #sendMessage(input: MessengerSendInput): Promise<MessengerSendResult> {
		const payload = await this.request<Record<string, unknown>>(
			`/${this.#graphVersion}/${encodeURIComponent(this.#pageId)}/messages`,
			{
				method: 'POST',
				body: {
					recipient: recipient(input.to),
					messaging_type: input.messagingType ?? 'RESPONSE',
					message: input.message,
					...(input.tag === undefined ? {} : { tag: required(input.tag, 'tag') }),
					...(input.notificationType === undefined
						? {}
						: { notification_type: input.notificationType }),
					...(input.replyToMessageId === undefined
						? {}
						: {
								reply_to: {
									mid: required(input.replyToMessageId, 'replyToMessageId'),
								},
							}),
				},
			},
		);
		const recipientId = readRequiredString(payload, 'recipient_id');
		const messageId = readOptionalString(payload, 'message_id');
		return {
			recipientId,
			...(messageId === undefined ? {} : { messageId }),
		};
	}

	async #sendAction(
		to: MessengerParticipantRef,
		action: MessengerSenderAction,
	): Promise<{ recipientId: string }> {
		let actionPayload: { [key: string]: MessengerJsonValue };
		if (action.type === 'react') {
			actionPayload = {
				sender_action: 'react',
				payload: {
					message_id: required(action.messageId, 'messageId'),
					reaction: required(action.reaction, 'reaction'),
				},
			};
		} else if (action.type === 'unreact') {
			actionPayload = {
				sender_action: 'unreact',
				payload: {
					message_id: required(action.messageId, 'messageId'),
				},
			};
		} else {
			actionPayload = { sender_action: action.type };
		}
		const payload = await this.request<Record<string, unknown>>(
			`/${this.#graphVersion}/${encodeURIComponent(this.#pageId)}/messages`,
			{
				method: 'POST',
				body: {
					recipient: recipient(to),
					...actionPayload,
				},
			},
		);
		return { recipientId: readRequiredString(payload, 'recipient_id') };
	}
}

function recipient(value: MessengerParticipantRef): { id: string } | { user_ref: string } {
	return value.type === 'page-scoped-id'
		? { id: required(value.id, 'recipient.id') }
		: { user_ref: required(value.id, 'recipient.userRef') };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	if (!isRecord(value)) {
		throw new Error('Messenger returned an invalid JSON response.');
	}
	return value;
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
	const item = readOptionalString(value, key);
	if (!item) throw new Error(`Messenger response did not include ${key}.`);
	return item;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function required(value: string, field: string): string {
	if (value.length === 0 || value.trim() !== value) {
		throw new TypeError(`Messenger ${field} is required.`);
	}
	return value;
}
