import type { Env, Handler } from 'hono';
import type {
	SalesforceMarketingCloudBatch,
	SalesforceMarketingCloudChannelOptions,
	SalesforceMarketingCloudEvent,
	SalesforceMarketingCloudVerification,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_BATCH_SIZE = 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createSalesforceMarketingCloudEventsHandler<E extends Env>(
	options: SalesforceMarketingCloudChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Salesforce Marketing Cloud bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.signatureKey);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		let rawBody: string;
		try {
			rawBody = decoder.decode(body.value);
		} catch {
			return response(400);
		}

		const signatureValue = request.headers.get('x-sfmc-ens-signature');
		if (signatureValue === null) {
			if (!options.verification) return response(401);
			const verification = parseVerification(rawBody);
			if (!verification) return response(401);
			if (options.callbackId !== undefined && verification.callbackId !== options.callbackId) {
				return response(403);
			}
			await options.verification({ c, verification });
			return response(200);
		}

		const signature = parseSignature(signatureValue);
		if (!signature) return response(401);
		if (!(await verifySignature(await key, body.value, signature))) {
			return response(401);
		}

		const batch = parseBatch(rawBody);
		if (!batch) return response(400);
		return serializeHandlerResult(await options.events({ c, batch }));
	};
}

function parseVerification(rawBody: string): SalesforceMarketingCloudVerification | undefined {
	let value: unknown;
	try {
		value = JSON.parse(rawBody);
	} catch {
		return undefined;
	}
	if (!isPlainObject(value)) return undefined;
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!keys.includes('callbackId') ||
		!keys.includes('verificationKey') ||
		!isNonEmptyString(value.callbackId) ||
		!isNonEmptyString(value.verificationKey)
	) {
		return undefined;
	}
	return {
		callbackId: value.callbackId,
		verificationKey: value.verificationKey,
	};
}

function parseBatch(rawBody: string): SalesforceMarketingCloudBatch | undefined {
	let value: unknown;
	try {
		value = JSON.parse(rawBody);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_SIZE) {
		return undefined;
	}
	for (const item of value) {
		if (!isMinimalEvent(item)) return undefined;
	}
	return { events: value as SalesforceMarketingCloudEvent[], rawBody };
}

/**
 * Minimal ingress validation: every ENS event is a JSON object carrying a
 * nonempty `eventCategoryType`. All other fields — including `timestampUTC`,
 * whose representation varies across event families — are forwarded as
 * Marketing Cloud delivered them; family-specific validation is application
 * policy.
 */
function isMinimalEvent(value: unknown): boolean {
	return isPlainObject(value) && isNonEmptyString(value.eventCategoryType);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

async function importSigningKey(signatureKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(signatureKey),
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

function parseSignature(value: string): Uint8Array | undefined {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
	try {
		const decoded = atob(value);
		if (decoded.length !== 32) return undefined;
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
