import type { Env, Handler } from 'hono';
import { isInteger, isLosslessNumber, isSafeNumber, parse } from 'lossless-json';
import type {
	JsonObject,
	JsonValue,
	ZendeskChannelOptions,
	ZendeskDelivery,
	ZendeskEvent,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const RETRYABLE_FAILURE_STATUS = 409;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createZendeskWebhookHandler<E extends Env>(
	options: ZendeskChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Zendesk webhook bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.signingSecret);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const signature = parseSignature(request.headers.get('x-zendesk-webhook-signature'));
		if (!signature) return response(401);

		const metadata = readMetadata(request.headers);
		if (!metadata) return response(400);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		const signedBytes = concatenate(encoder.encode(metadata.signatureTimestamp), body.value);
		if (!(await verifySignature(await key, signedBytes, signature))) {
			return response(401);
		}

		let rawBody: string;
		try {
			rawBody = decoder.decode(body.value);
		} catch {
			return response(400);
		}

		const payload = parseEvent(rawBody);
		if (!payload) return response(400);
		if (payload.account_id !== metadata.accountId) return response(403);
		if (options.accountId !== undefined && payload.account_id !== options.accountId) {
			return response(403);
		}
		if (options.webhookId !== undefined && metadata.webhookId !== options.webhookId) {
			return response(403);
		}

		const delivery: ZendeskDelivery = {
			webhookId: metadata.webhookId,
			invocationId: metadata.invocationId,
			signatureTimestamp: metadata.signatureTimestamp,
		};

		try {
			return serializeHandlerResult(await options.webhook({ c, payload, delivery }));
		} catch (error) {
			// Zendesk redelivers on 409 (the documented retryable status), so the
			// failure cannot propagate to the channel router's generic 500 — it
			// must be surfaced in logs here instead.
			console.error('[flue] Zendesk webhook handler failed:', error);
			return response(RETRYABLE_FAILURE_STATUS);
		}
	};
}

interface ZendeskRequestMetadata {
	accountId: string;
	webhookId: string;
	invocationId: string;
	signatureTimestamp: string;
}

function readMetadata(headers: Headers): ZendeskRequestMetadata | undefined {
	const accountId = readRequiredHeader(headers, 'x-zendesk-account-id');
	const webhookId = readRequiredHeader(headers, 'x-zendesk-webhook-id');
	const invocationId = readRequiredHeader(headers, 'x-zendesk-webhook-invocation-id');
	const signatureTimestamp = readRequiredHeader(headers, 'x-zendesk-webhook-signature-timestamp');
	if (
		!accountId ||
		!/^[1-9]\d*$/.test(accountId) ||
		!webhookId ||
		!invocationId ||
		!signatureTimestamp
	) {
		return undefined;
	}
	return { accountId, webhookId, invocationId, signatureTimestamp };
}

function readRequiredHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	return value && value.trim() === value ? value : undefined;
}

/**
 * Parses the verified body into Zendesk's provider-native common event
 * envelope. Field names, nesting, and discriminants are preserved; only the
 * required integer `account_id` is normalized to a lossless decimal string so
 * large account ids survive without JavaScript numeric rounding.
 */
function parseEvent(rawBody: string): ZendeskEvent | undefined {
	let parsed: unknown;
	try {
		parsed = parse(rawBody);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) return undefined;

	const accountId = normalizeAccountId(parsed.account_id);
	const value = normalizeJsonValue(parsed);
	if (!accountId || !isJsonObject(value)) return undefined;
	value.account_id = accountId;

	if (
		!readNonEmptyString(value, 'id') ||
		!readNonEmptyString(value, 'type') ||
		!readNonEmptyString(value, 'zendesk_event_version') ||
		!readNonEmptyString(value, 'subject') ||
		!readNonEmptyString(value, 'time') ||
		!readObject(value, 'detail') ||
		!readObject(value, 'event')
	) {
		return undefined;
	}

	return value as ZendeskEvent;
}

function normalizeAccountId(value: unknown): string | undefined {
	if (!isLosslessNumber(value) || !isInteger(value.value) || !/^[1-9]\d*$/.test(value.value)) {
		return undefined;
	}
	return value.value;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
	if (isLosslessNumber(value)) {
		return isSafeNumber(value.value) ? Number(value.value) : value.value;
	}
	if (Array.isArray(value)) {
		const result: JsonValue[] = [];
		for (const item of value) {
			const normalized = normalizeJsonValue(item);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}
	if (!isPlainObject(value)) return undefined;
	const result: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		const normalized = normalizeJsonValue(item);
		if (normalized === undefined) return undefined;
		result[key] = normalized;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		!isLosslessNumber(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readObject(record: JsonObject, key: string): JsonObject | undefined {
	const value = record[key];
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function readNonEmptyString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
}

async function verifySignature(
	key: CryptoKey,
	signedBytes: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		return await crypto.subtle.verify(
			'HMAC',
			key,
			copyArrayBuffer(signature),
			copyArrayBuffer(signedBytes),
		);
	} catch {
		return false;
	}
}

function parseSignature(value: string | null): Uint8Array | undefined {
	if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
	try {
		const decoded = atob(value);
		if (decoded.length !== 32) return undefined;
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		return undefined;
	}
}

function concatenate(prefix: Uint8Array, body: Uint8Array): Uint8Array {
	const value = new Uint8Array(prefix.byteLength + body.byteLength);
	value.set(prefix);
	value.set(body, prefix.byteLength);
	return value;
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<{ type: 'success'; value: Uint8Array } | { type: 'too-large' } | { type: 'invalid' }> {
	if (!request.body) return { type: 'success', value: new Uint8Array() };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				// Discard cancel rejections: an unhandled rejection is fatal on Node.
				reader.cancel().catch(() => {});
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { type: 'invalid' };
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { type: 'success', value: body };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
