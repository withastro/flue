import type { Env, Handler } from 'hono';
import {
	createInteractionTokenVerifier,
	createPubSubTokenVerifier,
	type GoogleChatInteractionAuthentication,
	type GoogleChatPubSubAuthentication,
	GoogleSigningKeyDiscoveryError,
} from './auth.ts';
import type {
	GoogleChatHandlerResult,
	GoogleChatInteractionHandlerInput,
	GoogleChatWorkspaceEventHandlerInput,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;

interface GoogleChatInteractionsHandlerOptions<E extends Env> {
	authentication: GoogleChatInteractionAuthentication;
	handler(input: GoogleChatInteractionHandlerInput<E>): GoogleChatHandlerResult;
	fetch?: typeof globalThis.fetch;
	bodyLimit?: number;
}

interface GoogleChatWorkspaceEventsHandlerOptions<E extends Env> {
	authentication: GoogleChatPubSubAuthentication;
	handler(input: GoogleChatWorkspaceEventHandlerInput<E>): GoogleChatHandlerResult;
	fetch?: typeof globalThis.fetch;
	bodyLimit?: number;
}

export function createGoogleChatInteractionsHandler<E extends Env>(
	options: GoogleChatInteractionsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = validateBodyLimit(options.bodyLimit);
	const verifyToken = createInteractionTokenVerifier(options.authentication, options);

	return async (c) => {
		if (!isJsonRequest(c.req.raw)) return response(415);
		const raw = await readRequestJson(c.req.raw, bodyLimit);
		if (raw.type === 'too-large') return response(413);
		if (raw.type === 'invalid' || typeof raw.value.type !== 'string' || !raw.value.type) {
			return response(400);
		}
		try {
			await verifyToken(c.req.header('authorization') ?? null);
		} catch (error) {
			return response(error instanceof GoogleSigningKeyDiscoveryError ? 503 : 401);
		}
		return serializeHandlerResult(
			await options.handler({
				c,
				payload: raw.value as GoogleChatInteractionHandlerInput<E>['payload'],
			}),
		);
	};
}

export function createGoogleChatWorkspaceEventsHandler<E extends Env>(
	options: GoogleChatWorkspaceEventsHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = validateBodyLimit(options.bodyLimit);
	const verifyToken = createPubSubTokenVerifier(options.authentication, options);

	return async (c) => {
		if (!isJsonRequest(c.req.raw)) return response(415);
		const raw = await readRequestJson(c.req.raw, bodyLimit);
		if (raw.type === 'too-large') return response(413);
		if (raw.type === 'invalid') return response(400);
		try {
			await verifyToken(c.req.header('authorization') ?? null);
		} catch (error) {
			return response(error instanceof GoogleSigningKeyDiscoveryError ? 503 : 401);
		}
		if (!isWorkspaceEventDelivery(raw.value)) return response(400);
		if (raw.value.subscription !== options.authentication.subscription) return response(403);
		return serializeHandlerResult(
			await options.handler({
				c,
				delivery: raw.value as unknown as GoogleChatWorkspaceEventHandlerInput<E>['delivery'],
			}),
		);
	};
}

function serializeHandlerResult(value: Awaited<GoogleChatHandlerResult>): Response {
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	if (value === undefined) return response(200);
	return Response.json(value);
}

function validateBodyLimit(value: number | undefined): number {
	const bodyLimit = value ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Google Chat bodyLimit must be a positive integer.');
	}
	return bodyLimit;
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
		'application/json'
	);
}

async function readRequestJson(
	request: Request,
	limit: number,
): Promise<
	{ type: 'success'; value: Record<string, unknown> } | { type: 'invalid' } | { type: 'too-large' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null) {
		if (!/^\d+$/.test(contentLength)) return { type: 'invalid' };
		if (Number(contentLength) > limit) return { type: 'too-large' };
	}
	// A mid-stream read failure is 'invalid' (→ 400), distinct from the
	// over-limit 'too-large' (→ 413) — the split every sibling reader makes
	// (github/src/webhook.ts readBody throws to its caller's 400 response).
	let bytes: Uint8Array | undefined;
	try {
		bytes = await readBody(request, limit);
	} catch {
		return { type: 'invalid' };
	}
	if (!bytes) return { type: 'too-large' };
	try {
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		return isRecord(value) ? { type: 'success', value } : { type: 'invalid' };
	} catch {
		return { type: 'invalid' };
	}
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
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

function isWorkspaceEventDelivery(value: Record<string, unknown>): boolean {
	if (typeof value.subscription !== 'string' || !value.subscription) return false;
	if (value.deliveryAttempt !== undefined && !isPositiveInteger(value.deliveryAttempt))
		return false;
	if (!isRecord(value.message)) return false;
	const message = value.message;
	if (
		typeof message.data !== 'string' ||
		!message.data ||
		typeof message.messageId !== 'string' ||
		!message.messageId ||
		!isRecord(message.attributes)
	) {
		return false;
	}
	const attributes = message.attributes;
	const source = readString(attributes, 'ce-source');
	const subject = readString(attributes, 'ce-subject');
	const eventType = readString(attributes, 'ce-type');
	if (
		attributes['ce-specversion'] !== '1.0' ||
		attributes['ce-datacontenttype'] !== 'application/json' ||
		!readString(attributes, 'ce-id') ||
		!source?.startsWith('//workspaceevents.googleapis.com/subscriptions/') ||
		!subject ||
		!eventType
	) {
		return false;
	}
	if (eventType.startsWith('google.workspace.events.subscription.v1.')) {
		if (subject !== source) return false;
	} else if (
		!/^\/\/chat\.googleapis\.com\/spaces\/[^/]+$/.test(subject) &&
		!/^\/\/cloudidentity\.googleapis\.com\/users\/[^/]+$/.test(subject)
	) {
		return false;
	}
	return decodeBase64Json(message.data) !== undefined;
}

function decodeBase64Json(value: string): Record<string, unknown> | undefined {
	try {
		const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
