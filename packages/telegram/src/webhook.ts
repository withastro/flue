import type { Update } from '@grammyjs/types';
import type { Env, Handler } from 'hono';
import type { TelegramChannelOptions, TelegramHandlerResult } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createTelegramWebhookHandler<E extends Env>(
	options: TelegramChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Telegram webhook bodyLimit must be a positive integer.');
	}
	const expectedSecretDigest = digestSecret(options.secretToken);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		if (
			!secureEqual(
				await expectedSecretDigest,
				await digestSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? ''),
			)
		) {
			return response(401);
		}

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		const raw = parseJson(body.value);
		if (!isUpdate(raw)) return response(400);

		let result: TelegramHandlerResult;
		try {
			result = await options.webhook({ c, update: raw });
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result);
	};
}

/**
 * Minimal envelope check: a verified webhook body must be a JSON object with a
 * non-negative integer `update_id`. The provider-native fields are forwarded
 * unmodified; Flue does not exhaustively validate the typed `Update` schema.
 */
function isUpdate(value: unknown): value is Update {
	if (!isRecord(value)) return false;
	const updateId = value.update_id;
	return typeof updateId === 'number' && Number.isSafeInteger(updateId) && updateId >= 0;
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

function secureEqual(expected: Uint8Array, actual: Uint8Array): boolean {
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected[index] as number) ^ (actual[index] as number);
	}
	return difference === 0;
}

async function digestSecret(secret: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
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
	if (contentLength !== null && Number(contentLength) > bodyLimit) {
		return { type: 'too-large' };
	}
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

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(body));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
