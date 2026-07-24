import type { Env, Handler } from 'hono';
import type { DiscordHandlerResult, DiscordInteractionsHandlerInput } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

interface DiscordInteractionsHandlerOptions<E extends Env> {
	publicKey: Uint8Array;
	bodyLimit?: number;
	interactions(input: DiscordInteractionsHandlerInput<E>): DiscordHandlerResult;
}

export function createDiscordInteractionsHandler<E extends Env>(
	options: DiscordInteractionsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Discord route bodyLimit must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;
		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json') return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return response(400);
			if (Number(contentLength) > bodyLimit) return response(413);
		}

		const signature = parseHex(request.headers.get('x-signature-ed25519'), 64);
		const timestampText = request.headers.get('x-signature-timestamp');
		const timestamp = parseTimestamp(timestampText);
		if (
			!signature ||
			timestampText === null ||
			timestamp === undefined ||
			Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SIGNATURE_AGE_SECONDS
		) {
			return response(401);
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return response(400);
		}
		if (!body) return response(413);
		if (!(await verifySignature(options.publicKey, timestampText, body, signature))) {
			return response(401);
		}

		const raw = parseJson(body);
		if (!isRecord(raw)) return response(400);
		const type = readInteger(raw, 'type');
		if (type === 1) return Response.json({ type: 1 });
		if (type === undefined) return response(400);

		return serializeHandlerResult(
			await options.interactions({
				c,
				interaction: raw as unknown as DiscordInteractionsHandlerInput<E>['interaction'],
			}),
		);
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

async function readBody(request: Request, bodyLimit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
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
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseTimestamp(value: string | null): number | undefined {
	return parseNonNegativeInteger(value);
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseHex(value: string | null, byteLength: number): Uint8Array | undefined {
	const expression = new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`);
	if (!expression.test(value ?? '')) return undefined;
	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt((value ?? '').slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifySignature(
	publicKey: Uint8Array,
	timestamp: string,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		const prefix = encoder.encode(timestamp);
		const signed = new Uint8Array(prefix.byteLength + body.byteLength);
		signed.set(prefix);
		signed.set(body, prefix.byteLength);
		const key = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(publicKey),
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		return await crypto.subtle.verify(
			'Ed25519',
			key,
			toArrayBuffer(signature),
			toArrayBuffer(signed),
		);
	} catch {
		return false;
	}
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}

function readInteger(value: Record<string, unknown>, key: string): number | undefined {
	const field = value[key];
	return typeof field === 'number' && Number.isSafeInteger(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
