import type { Env, Handler } from 'hono';
import { isSafeNumber, parse } from 'lossless-json';
import type { JsonValue, ShopifyChannelOptions } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createShopifyWebhookHandler<E extends Env>(
	options: ShopifyChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Shopify webhook bodyLimit must be a positive integer.');
	}

	const keyPromises = [options.clientSecret, options.previousClientSecret]
		.filter((secret): secret is string => secret !== undefined)
		.map((secret) => importHmacKey(secret));

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const signature = parseSignature(request.headers.get('x-shopify-hmac-sha256'));
		if (!signature) return response(401);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		if (!(await verifyAnySignature(keyPromises, body.value, signature))) {
			return response(401);
		}

		let rawBody: string;
		try {
			rawBody = decoder.decode(body.value);
		} catch {
			return response(400);
		}

		let payload: JsonValue;
		try {
			payload = parse(rawBody, null, {
				parseNumber: (value) => (isSafeNumber(value) ? Number(value) : value),
			}) as JsonValue;
		} catch {
			return response(400);
		}

		return serializeHandlerResult(await options.webhook({ c, payload, rawBody }));
	};
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
}

async function verifyAnySignature(
	keyPromises: Promise<CryptoKey>[],
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		const keys = await Promise.all(keyPromises);
		const signatureBuffer = copyArrayBuffer(signature);
		const bodyBuffer = copyArrayBuffer(body);
		const results = await Promise.all(
			keys.map((key) => crypto.subtle.verify('HMAC', key, signatureBuffer, bodyBuffer)),
		);
		return results.some(Boolean);
	} catch {
		return false;
	}
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function parseSignature(value: string | null): Uint8Array | undefined {
	if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
	try {
		const binary = atob(value);
		if (binary.length !== 32) return undefined;
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return undefined;
	}
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

function response(status: number): Response {
	return new Response(null, { status });
}
