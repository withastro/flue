import type { Env, Handler } from 'hono';
import type {
	IntercomChannelOptions,
	IntercomNotification,
	JsonObject,
	JsonValue,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createIntercomValidationHandler<E extends Env>(): Handler<E> {
	return () => response(200);
}

export function createIntercomWebhookHandler<E extends Env>(
	options: IntercomChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Intercom webhook bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.clientSecret);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) {
			return response(400);
		}
		if (contentLength !== null && Number(contentLength) > bodyLimit) {
			return response(413);
		}

		const signature = parseSignature(request.headers.get('x-hub-signature'));
		if (!signature) return response(401);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);
		if (!(await verifySignature(await key, body.value, signature))) {
			return response(401);
		}

		let rawBody: string;
		try {
			rawBody = decoder.decode(body.value);
		} catch {
			return response(400);
		}
		const raw = parseJsonObject(rawBody);
		if (!raw) return response(400);
		const notification = readNotification(raw);
		if (!notification) return response(400);
		return serializeHandlerResult(await options.webhook({ c, notification }));
	};
}

/**
 * Validates only the common notification envelope Flue owns to route ingress.
 * The full provider object is returned with Intercom's own field names; the
 * `data.item` payload and any unmodeled top-level fields are forwarded
 * unchanged for the application to interpret.
 */
function readNotification(raw: JsonObject): IntercomNotification | undefined {
	if (raw.type !== 'notification_event') return undefined;
	const topic = readNonEmptyString(raw, 'topic');
	const appId = readNonEmptyString(raw, 'app_id');
	const id = raw.id === null ? null : readNonEmptyString(raw, 'id');
	const createdAt = readNonNegativeInteger(raw, 'created_at');
	const deliveryAttempts = readPositiveInteger(raw, 'delivery_attempts');
	const firstSentAt = readNonNegativeInteger(raw, 'first_sent_at');
	const data = readObject(raw, 'data');
	if (
		!topic ||
		!appId ||
		(raw.id !== null && !id) ||
		createdAt === undefined ||
		deliveryAttempts === undefined ||
		firstSentAt === undefined ||
		!data ||
		!Object.hasOwn(data, 'item')
	) {
		return undefined;
	}
	const self = raw.self;
	if (self !== undefined && self !== null && (typeof self !== 'string' || self.length === 0)) {
		return undefined;
	}
	return raw as unknown as IntercomNotification;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['verify'],
	);
}

async function verifySignature(
	key: CryptoKey,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		return await crypto.subtle.verify(
			'HMAC',
			key,
			copyArrayBuffer(signature),
			copyArrayBuffer(body),
		);
	} catch {
		return false;
	}
}

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^sha1=([a-fA-F0-9]{40})$/.exec(value ?? '');
	if (!match?.[1]) return undefined;
	const bytes = new Uint8Array(20);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function parseJsonObject(value: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype &&
		isJsonValue(value)
	);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
		return false;
	}
	seen.add(value);
	try {
		return Array.isArray(value)
			? value.every((item) => isJsonValue(item, seen))
			: Object.values(value).every((item) => isJsonValue(item, seen));
	} finally {
		seen.delete(value);
	}
}

function readObject(record: JsonObject, key: string): JsonObject | undefined {
	const value = record[key];
	return isJsonObject(value) ? value : undefined;
}

function readNonEmptyString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNonNegativeInteger(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function readPositiveInteger(record: JsonObject, key: string): number | undefined {
	const value = readNonNegativeInteger(record, key);
	return value !== undefined && value > 0 ? value : undefined;
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
				void reader.cancel();
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
