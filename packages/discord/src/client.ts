import { normalizeMessageComponents } from './components.ts';
import {
	DiscordApiError,
	DiscordRateLimitError,
	DiscordTimeoutError,
	InvalidDiscordInputError,
} from './errors.ts';
import type {
	DiscordChannelOptions,
	DiscordClient,
	DiscordDestinationRef,
	DiscordMessage,
} from './index.ts';

const API_ORIGIN = 'https://discord.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export function createDiscordClient(options: DiscordChannelOptions): DiscordClient {
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const botToken = options.botToken;

	return {
		async postMessage(ref, message, signal) {
			assertDestinationRef(ref);
			assertMessage(message);
			await request(
				`/api/v10/channels/${encodeURIComponent(ref.channelId)}/messages`,
				serializeMessage(message),
				signal,
			);
		},
	};

	async function request(
		path: string,
		body: Record<string, unknown>,
		callerSignal?: AbortSignal,
	): Promise<void> {
		let url = new URL(path, API_ORIGIN);
		let redirects = 0;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, timeoutSignal])
			: timeoutSignal;

		try {
			while (true) {
				const response = await fetchImplementation(url, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						Authorization: `Bot ${botToken}`,
						'Content-Type': 'application/json',
						'User-Agent': '@flue/discord',
					},
					body: JSON.stringify(body),
					redirect: 'manual',
					signal,
				});

				if (isRedirect(response.status)) {
					const location = response.headers.get('location');
					if (!location || redirects >= MAX_REDIRECTS) {
						throw await createApiError(response, botToken);
					}
					const nextUrl = new URL(location, url);
					if (nextUrl.protocol !== 'https:' || nextUrl.origin !== API_ORIGIN) {
						throw await createApiError(response, botToken);
					}
					void response.body?.cancel();
					url = nextUrl;
					redirects += 1;
					continue;
				}

				if (response.ok) {
					void response.body?.cancel();
					return;
				}
				throw await createApiError(response, botToken);
			}
		} catch (error) {
			if (timeoutSignal.aborted && !callerSignal?.aborted) {
				throw new DiscordTimeoutError(timeoutMs);
			}
			throw error;
		}
	}
}

function serializeMessage(message: DiscordMessage): Record<string, unknown> {
	const components =
		message.components === undefined ? undefined : normalizeMessageComponents(message.components);
	if (message.components !== undefined && !components) {
		throw new InvalidDiscordInputError('message components');
	}
	return {
		content: message.content,
		...(components === undefined ? {} : { components }),
		allowed_mentions: {
			parse: message.allowedMentions?.parse ?? [],
			...(message.allowedMentions?.users === undefined
				? {}
				: { users: message.allowedMentions.users }),
			...(message.allowedMentions?.roles === undefined
				? {}
				: { roles: message.allowedMentions.roles }),
		},
	};
}

function assertDestinationRef(ref: DiscordDestinationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidDiscordInputError('ref');
	assertIdentifier(ref.channelId, 'channelId');
	if (ref.type === 'guild') {
		assertIdentifier(ref.guildId, 'guildId');
		if (ref.channelKind !== 'channel' && ref.channelKind !== 'thread') {
			throw new InvalidDiscordInputError('channelKind');
		}
		return;
	}
	if (ref.type !== 'dm') throw new InvalidDiscordInputError('destination type');
}

function assertMessage(message: DiscordMessage): void {
	if (!message || typeof message !== 'object') throw new InvalidDiscordInputError('message');
	if (typeof message.content !== 'string' || message.content.length === 0) {
		throw new InvalidDiscordInputError('message content');
	}
	if (
		message.components !== undefined &&
		normalizeMessageComponents(message.components) === undefined
	) {
		throw new InvalidDiscordInputError('message components');
	}
	const mentions = message.allowedMentions;
	if (mentions === undefined) return;
	if (!mentions || typeof mentions !== 'object') {
		throw new InvalidDiscordInputError('allowedMentions');
	}
	if (
		mentions.parse !== undefined &&
		(!Array.isArray(mentions.parse) ||
			mentions.parse.some(
				(value) => value !== 'users' && value !== 'roles' && value !== 'everyone',
			))
	) {
		throw new InvalidDiscordInputError('allowedMentions.parse');
	}
	assertIdentifierArray(mentions.users, 'allowedMentions.users');
	assertIdentifierArray(mentions.roles, 'allowedMentions.roles');
	if (mentions.parse?.includes('users') && mentions.users !== undefined) {
		throw new InvalidDiscordInputError('allowedMentions.users');
	}
	if (mentions.parse?.includes('roles') && mentions.roles !== undefined) {
		throw new InvalidDiscordInputError('allowedMentions.roles');
	}
}

function assertIdentifierArray(value: readonly string[] | undefined, field: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((item) => !isIdentifier(item))) {
		throw new InvalidDiscordInputError(field);
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (!isIdentifier(value)) throw new InvalidDiscordInputError(field);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRedirect(status: number): boolean {
	return status === 307 || status === 308;
}

async function createApiError(response: Response, token: string): Promise<DiscordApiError> {
	const payload = await readResponsePayload(response, token);
	const numericCode = isRecord(payload) && typeof payload.code === 'number' ? payload.code : undefined;
	const code = numericCode === undefined ? 'http_error' : String(numericCode);
	const responseMessage =
		isRecord(payload) && typeof payload.message === 'string'
			? payload.message.slice(0, 1_000)
			: undefined;
	const retryAfterSeconds =
		(isRecord(payload) && typeof payload.retry_after === 'number'
			? parseNonNegativeNumber(payload.retry_after)
			: undefined) ?? parseNonNegativeNumber(response.headers.get('retry-after'));
	const options = {
		status: response.status,
		code,
		requestId: response.headers.get('x-discord-request-id') ?? undefined,
		responseMessage,
		retryAfterSeconds,
		global: isRecord(payload) && payload.global === true ? true : undefined,
		rateLimitScope: response.headers.get('x-ratelimit-scope') ?? undefined,
		rateLimitBucket: response.headers.get('x-ratelimit-bucket') ?? undefined,
	};
	return response.status === 429 || retryAfterSeconds !== undefined
		? new DiscordRateLimitError(options)
		: new DiscordApiError(options);
}

async function readResponsePayload(response: Response, token: string): Promise<unknown> {
	const bytes = await readBoundedBody(response, MAX_RESPONSE_BODY_BYTES);
	if (bytes.byteLength === 0) return undefined;
	const text = new TextDecoder().decode(bytes);
	try {
		return redactStrings(JSON.parse(text), token);
	} catch {
		return undefined;
	}
}

function redactStrings(value: unknown, token: string): unknown {
	if (typeof value === 'string') return value.split(token).join('[REDACTED]');
	if (Array.isArray(value)) return value.map((item) => redactStrings(item, token));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, redactStrings(item, token)]),
	);
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = limit - total;
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			chunks.push(chunk);
			total += chunk.byteLength;
			if (value.byteLength >= remaining) {
				void reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
	const parsed = typeof value === 'string' && value.length > 0 ? Number(value) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
		? parsed
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
