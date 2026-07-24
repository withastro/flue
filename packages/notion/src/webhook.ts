import type { Env, Handler } from 'hono';
import type { NotionChannelOptions, NotionWebhookEvent } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();

export function createNotionWebhookHandler<E extends Env>(
	options: NotionChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Notion webhook bodyLimit must be a positive integer.');
	}
	const key =
		options.verificationToken === undefined
			? undefined
			: importSigningKey(options.verificationToken);
	const expectedVerificationDigest =
		options.verificationToken === undefined ? undefined : digestToken(options.verificationToken);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		const signatureHeader = request.headers.get('x-notion-signature');
		if (!signatureHeader) {
			const raw = parseJson(body.value);
			const verificationToken = isRecord(raw)
				? readNonEmptyString(raw, 'verification_token')
				: undefined;
			if (!verificationToken) return response(401);
			if (expectedVerificationDigest !== undefined) {
				const actualDigest = await digestToken(verificationToken);
				if (secureEqual(await expectedVerificationDigest, actualDigest)) return response(200);
				// A mismatched token is a re-verification after Notion rotated
				// it. The configured token cannot answer that delivery, so the
				// verification handler must keep running — it is the only path
				// that surfaces the new token to the operator.
			}
			if (options.verification) {
				return serializeHandlerResult(await options.verification({ c, verificationToken }));
			}
			return expectedVerificationDigest !== undefined ? response(403) : response(401);
		}

		if (!key) return response(503);
		const signature = parseSignature(signatureHeader);
		if (!signature || !(await verifySignature(await key, body.value, signature))) {
			return response(401);
		}

		const raw = parseJson(body.value);
		if (!isRecord(raw) || readNonEmptyString(raw, 'type') === undefined) {
			return response(400);
		}
		const event = raw as unknown as NotionWebhookEvent;
		return serializeHandlerResult(await options.webhook({ c, event }));
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

function parseSignature(value: string): Uint8Array | undefined {
	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value);
	const hex = match?.[1];
	if (!hex) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
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

async function digestToken(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function secureEqual(expected: Uint8Array, actual: Uint8Array): boolean {
	if (expected.length !== actual.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected[index] as number) ^ (actual[index] as number);
	}
	return difference === 0;
}

function parseJson(body: Uint8Array): unknown {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function response(status: number): Response {
	return new Response(null, { status });
}
