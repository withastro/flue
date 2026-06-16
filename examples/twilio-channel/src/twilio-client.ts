export interface TwilioClientOptions {
	accountSid: string;
	authToken: string;
	fetch?: typeof globalThis.fetch;
	apiBaseUrl?: string;
}

export type TwilioCreateMessageInput = {
	to: string;
	body?: string;
	mediaUrl?: readonly string[];
	statusCallback?: string;
} & ({ from: string; messagingServiceSid?: never } | { from?: never; messagingServiceSid: string });

export interface TwilioMessageResult {
	sid: string;
	status?: string;
}

export class TwilioClient {
	readonly messages: {
		create(input: TwilioCreateMessageInput): Promise<TwilioMessageResult>;
	};

	readonly #accountSid: string;
	readonly #authToken: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #apiBaseUrl: string;

	constructor(options: TwilioClientOptions) {
		this.#accountSid = required(options.accountSid, 'accountSid');
		this.#authToken = required(options.authToken, 'authToken');
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
		this.messages = {
			create: (input) => this.#createMessage(input),
		};
	}

	async #createMessage(input: TwilioCreateMessageInput): Promise<TwilioMessageResult> {
		required(input.to, 'to');
		if (
			(input.body === undefined || input.body.length === 0) &&
			(!input.mediaUrl || input.mediaUrl.length === 0)
		) {
			throw new TypeError('Twilio message requires body or mediaUrl.');
		}
		const form = new URLSearchParams({ To: input.to });
		if (input.body !== undefined) form.set('Body', input.body);
		if (input.from !== undefined) form.set('From', required(input.from, 'from'));
		if (input.messagingServiceSid !== undefined) {
			form.set('MessagingServiceSid', required(input.messagingServiceSid, 'messagingServiceSid'));
		}
		for (const url of input.mediaUrl ?? []) {
			form.append('MediaUrl', required(url, 'mediaUrl'));
		}
		if (input.statusCallback !== undefined) {
			form.set('StatusCallback', required(input.statusCallback, 'statusCallback'));
		}

		const result = await this.#fetch(
			`${this.#apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(
				this.#accountSid,
			)}/Messages.json`,
			{
				method: 'POST',
				headers: {
					authorization: `Basic ${basicAuth(this.#accountSid, this.#authToken)}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: form,
			},
		);
		const payload = await readJson(result);
		if (!result.ok) {
			const detail =
				typeof payload.message === 'string'
					? payload.message
					: `Twilio request failed with status ${result.status}.`;
			throw new Error(detail);
		}
		if (typeof payload.sid !== 'string' || payload.sid.length === 0) {
			throw new Error('Twilio response did not include a message SID.');
		}
		return {
			sid: payload.sid,
			...(typeof payload.status === 'string' ? { status: payload.status } : {}),
		};
	}
}

function basicAuth(username: string, password: string): string {
	return btoa(`${username}:${password}`);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error('Twilio returned an invalid JSON response.');
	}
	return value as Record<string, unknown>;
}

function required(value: string, field: string): string {
	if (value.length === 0 || value.trim() !== value) {
		throw new TypeError(`Twilio ${field} is required.`);
	}
	return value;
}
