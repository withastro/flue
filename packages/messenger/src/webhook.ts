import type { Env, Handler } from 'hono';
import type { MessengerChannelOptions, MessengerWebhookPayload } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const EVENT_RECEIVED = 'EVENT_RECEIVED';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createMessengerVerificationHandler<E extends Env>(
	options: MessengerChannelOptions<E>,
): Handler<E> {
	const expectedTokenDigest = digest(options.verifyToken);
	return async (c) => {
		const url = new URL(c.req.url);
		const mode = readSingleQuery(url, 'hub.mode');
		const challenge = readSingleQuery(url, 'hub.challenge');
		const token = readSingleQuery(url, 'hub.verify_token');
		if (mode === undefined || challenge === undefined || token === undefined) {
			return response(400);
		}
		if (mode !== 'subscribe' || challenge.length === 0) return response(400);
		if (!secureEqual(await expectedTokenDigest, await digest(token))) {
			return response(403);
		}
		return new Response(challenge, {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=UTF-8' },
		});
	};
}

export function createMessengerWebhookHandler<E extends Env>(
	options: MessengerChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Messenger webhook bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.appSecret);
	const pageId = options.pageId;

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		const signature = parseSignature(request.headers.get('x-hub-signature-256'));
		if (!signature) return response(401);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);
		if (!(await verifySignature(await key, body.value, signature))) {
			return response(401);
		}

		const raw = parseJson(body.value);
		if (!isRecord(raw) || raw.object !== 'page' || !Array.isArray(raw.entry)) {
			return response(400);
		}
		for (const entry of raw.entry) {
			if (!isRecord(entry)) return response(400);
			const entryPageId = entry.id;
			if (typeof entryPageId !== 'string' || entryPageId.length === 0) {
				return response(400);
			}
			if (entryPageId !== pageId) return response(403);
		}

		return serializeHandlerResult(
			await options.webhook({
				c,
				payload: raw as unknown as MessengerWebhookPayload,
			}),
		);
	};
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
): Promise<{ type: 'ok'; value: Uint8Array } | { type: 'too-large' } | { type: 'invalid' }> {
	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const length = Number(contentLength);
		if (Number.isFinite(length) && length > bodyLimit) {
			return { type: 'too-large' };
		}
	}
	if (!request.body) return { type: 'ok', value: new Uint8Array() };
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
	return { type: 'ok', value: body };
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(body));
	} catch {
		return undefined;
	}
}

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? '');
	const hex = match?.[1];
	if (!hex) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		toArrayBuffer(encoder.encode(secret)),
		{ name: 'HMAC', hash: 'SHA-256' },
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
		return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(body));
	} catch {
		return false;
	}
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function secureEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

function readSingleQuery(url: URL, name: string): string | undefined {
	const values = url.searchParams.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) {
		return new Response(EVENT_RECEIVED, {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=UTF-8' },
		});
	}
	if (Object.prototype.toString.call(value) === '[object Response]') {
		return value as Response;
	}
	return Response.json(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
