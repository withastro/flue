import type { Env, Handler } from 'hono';
import type {
	SlackCommandsHandlerInput,
	SlackEventsHandlerInput,
	SlackHandlerResult,
	SlackInteractionsHandlerInput,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

interface SharedRouteOptions {
	signingSecret: string;
	bodyLimit?: number;
}

interface SlackEventsHandlerOptions<E extends Env> extends SharedRouteOptions {
	events(input: SlackEventsHandlerInput<E>): SlackHandlerResult;
}

interface SlackInteractionsHandlerOptions<E extends Env> extends SharedRouteOptions {
	interactions(input: SlackInteractionsHandlerInput<E>): SlackHandlerResult;
}

interface SlackCommandsHandlerOptions<E extends Env> extends SharedRouteOptions {
	commands(input: SlackCommandsHandlerInput<E>): SlackHandlerResult;
}

export function createSlackEventsHandler<E extends Env>(
	options: SlackEventsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/json');
		if (verified instanceof Response) return verified;
		const raw = parseJson(verified.body);
		if (!isRecord(raw)) return response(400);

		const envelopeType = readString(raw, 'type');
		if (!envelopeType) return response(400);
		if (envelopeType === 'url_verification') {
			const challenge = readString(raw, 'challenge');
			if (challenge === undefined) return response(400);
			return Response.json({ challenge }, { status: 200 });
		}

		if (envelopeType === 'event_callback') {
			const eventId = readString(raw, 'event_id');
			const event = readRecord(raw, 'event');
			if (!eventId || !event || !readString(event, 'type')) return response(400);
		}

		return serializeHandlerResult(
			await options.events({
				c,
				payload: raw as unknown as SlackEventsHandlerInput<E>['payload'],
			}),
		);
	};
}

export function createSlackInteractionsHandler<E extends Env>(
	options: SlackInteractionsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/x-www-form-urlencoded');
		if (verified instanceof Response) return verified;
		const raw = parseFormPayload(verified.body);
		if (!isRecord(raw)) return response(400);

		const type = readString(raw, 'type');
		if (!type) return response(400);
		return serializeHandlerResult(
			await options.interactions({
				c,
				payload: raw as unknown as SlackInteractionsHandlerInput<E>['payload'],
			}),
		);
	};
}

export function createSlackCommandsHandler<E extends Env>(
	options: SlackCommandsHandlerOptions<E>,
): Handler<E> {
	const route = prepareRoute(options);

	return async (c) => {
		const request = c.req.raw;
		const verified = await route.verify(request, 'application/x-www-form-urlencoded');
		if (verified instanceof Response) return verified;
		const form = parseForm(verified.body);
		if (!form) return response(400);
		const payload = formToRecord(form);
		if (typeof payload.command !== 'string') return response(400);
		return serializeHandlerResult(
			await options.commands({
				c,
				payload: payload as unknown as SlackCommandsHandlerInput<E>['payload'],
			}),
		);
	};
}

function prepareRoute(options: SharedRouteOptions): {
	verify(request: Request, expectedMediaType: string): Promise<{ body: Uint8Array } | Response>;
} {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Slack route bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.signingSecret);

	return {
		async verify(request, expectedMediaType) {
			const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
			if (mediaType !== expectedMediaType) return response(415);

			const contentLength = request.headers.get('content-length');
			if (contentLength !== null) {
				if (!/^\d+$/.test(contentLength)) return response(400);
				if (Number(contentLength) > bodyLimit) return response(413);
			}

			let body: Uint8Array | undefined;
			try {
				body = await readBody(request, bodyLimit);
			} catch {
				return response(400);
			}
			if (!body) return response(413);

			const timestampText = request.headers.get('x-slack-request-timestamp');
			const timestamp = parseTimestamp(timestampText);
			const signature = parseSignature(request.headers.get('x-slack-signature'));
			if (
				timestampText === null ||
				timestamp === undefined ||
				Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SIGNATURE_AGE_SECONDS ||
				!signature ||
				!(await verifySignature(await key, timestampText, body, signature))
			) {
				return response(401);
			}
			return { body };
		},
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
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

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^v0=([0-9a-fA-F]{64})$/.exec(value ?? '');
	if (!match?.[1]) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
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
	timestamp: string,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	// The `v0:{ts}:` signed-data prefix is Slack protocol and stays local.
	const prefix = encoder.encode(`v0:${timestamp}:`);
	const signed = new Uint8Array(prefix.byteLength + body.byteLength);
	signed.set(prefix);
	signed.set(body, prefix.byteLength);
	// verify() can throw on malformed input in workerd; report false like the
	// sfmc/zendesk/intercom copies (awaited so rejections are caught too).
	try {
		return await crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(signed));
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

function parseFormPayload(body: Uint8Array): unknown {
	try {
		const form = parseForm(body);
		if (!form) return undefined;
		const payloads = form.getAll('payload');
		if (payloads.length !== 1) return undefined;
		return JSON.parse(payloads[0] ?? '');
	} catch {
		return undefined;
	}
}

function parseForm(body: Uint8Array): URLSearchParams | undefined {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		return new URLSearchParams(text);
	} catch {
		return undefined;
	}
}

function formToRecord(form: URLSearchParams): Record<string, string | string[]> {
	const record: Record<string, string | string[]> = {};
	for (const key of new Set(form.keys())) {
		const values = form.getAll(key);
		record[key] = values.length === 1 && values[0] !== undefined ? values[0] : values;
	}
	return record;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}

function readRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const field = value[key];
	return isRecord(field) ? field : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' ? field : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
