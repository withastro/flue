import type { LinearWebhookPayload } from '@linear/sdk/webhooks';
import type { Env, Handler } from 'hono';
import type { LinearChannelOptions } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const TIMESTAMP_TOLERANCE_MS = 60_000;
const encoder = new TextEncoder();

export function createLinearWebhookHandler<E extends Env>(
	options: LinearChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Linear webhook bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.webhookSecret);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		const rawBody = await readBody(request, bodyLimit);
		if (rawBody.type === 'too-large') return response(413);
		if (rawBody.type === 'invalid') return response(400);

		const signature = parseSignature(request.headers.get('linear-signature'));
		if (!signature || !(await verifySignature(await key, rawBody.value, signature))) {
			return response(401);
		}

		const raw = parseJson(rawBody.value);
		if (!isRecord(raw)) return response(400);

		// Minimal ingress checks Flue owns: replay window and configured identity.
		// Everything else is the provider-native payload, forwarded unmodified.
		const webhookTimestamp = raw.webhookTimestamp;
		if (typeof webhookTimestamp !== 'number' || !Number.isFinite(webhookTimestamp)) {
			return response(400);
		}
		if (Math.abs(Date.now() - webhookTimestamp) > TIMESTAMP_TOLERANCE_MS) {
			return response(401);
		}
		if (options.organizationId && raw.organizationId !== options.organizationId) {
			return response(403);
		}
		if (options.webhookId && raw.webhookId !== options.webhookId) {
			return response(403);
		}

		const deliveryId = request.headers.get('linear-delivery');
		if (!deliveryId || !isUuidV4(deliveryId)) return response(400);
		return serializeHandlerResult(
			await options.webhook({
				c,
				payload: raw as unknown as LinearWebhookPayload,
				deliveryId,
			}),
		);
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

function isJsonRequest(request: Request): boolean {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null && !/^\d+$/.test(contentLength)) return false;
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<{ type: 'success'; value: Uint8Array } | { type: 'too-large' } | { type: 'invalid' }> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > bodyLimit) return { type: 'too-large' };
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

function parseSignature(value: string | null): Uint8Array | undefined {
	if (!/^[0-9a-fA-F]{64}$/.test(value ?? '')) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt((value as string).slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

// Imported once at handler creation and awaited per use — the
// messenger/src/webhook.ts importSigningKey shape.
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
	// verify() can throw on malformed input in workerd; report false like the
	// sfmc/zendesk/intercom copies (awaited so rejections are caught too).
	try {
		return await crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(body));
	} catch {
		return false;
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuidV4(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
