import type { Env, Handler } from 'hono';
import type { NotionChannelOptions, NotionHandlerResult, NotionWebhookEvent } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();

export function createNotionWebhookHandler<E extends Env>(
	options: NotionChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Notion webhook bodyLimit must be a positive integer.');
	}
	const secret =
		options.verificationToken === undefined ? undefined : encoder.encode(options.verificationToken);

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
			const verificationToken =
				isRecord(raw) && Object.keys(raw).length === 1
					? readNonEmptyString(raw, 'verification_token')
					: undefined;
			if (!verificationToken) return response(401);
			if (options.verificationToken !== undefined) {
				return verificationToken === options.verificationToken ? response(200) : response(403);
			}
			if (options.verification) {
				return runHandler(() => options.verification?.({ c, verificationToken }));
			}
			return response(401);
		}

		if (!secret) return response(503);
		const signature = parseSignature(signatureHeader);
		if (!signature || !(await verifySignature(secret, body.value, signature))) {
			return response(401);
		}

		const raw = parseJson(body.value);
		if (!isRecord(raw) || readNonEmptyString(raw, 'type') === undefined) {
			return response(400);
		}
		const event = raw as unknown as NotionWebhookEvent;
		return runHandler(() => options.webhook({ c, event }));
	};
}

async function runHandler(handler: () => NotionHandlerResult | undefined): Promise<Response> {
	try {
		return serializeHandlerResult(await handler());
	} catch {
		return response(500);
	}
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

async function verifySignature(
	secret: Uint8Array,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(body));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
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
