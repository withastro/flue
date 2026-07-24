import type { WebhookEventName } from '@octokit/webhooks-types';
import type { Context, Env, Handler } from 'hono';
import type { GitHubWebhookDelivery, GitHubWebhookHandlerResult } from './index.ts';

const DEFAULT_BODY_LIMIT = 25 * 1024 * 1024;
const encoder = new TextEncoder();

interface GitHubWebhookHandlerOptions<E extends Env> {
	webhookSecret: string;
	bodyLimit?: number;
	webhook(input: { c: Context<E>; delivery: GitHubWebhookDelivery }): GitHubWebhookHandlerResult;
}

export function createGitHubWebhookHandler<E extends Env>(
	options: GitHubWebhookHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('GitHub webhook bodyLimit must be a positive integer.');
	}
	const key = importSigningKey(options.webhookSecret);

	return async (c) => {
		const request = c.req.raw;
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return new Response(null, { status: 400 });
			if (Number(contentLength) > bodyLimit) return new Response(null, { status: 413 });
		}

		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json') {
			return new Response(null, { status: 415 });
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return new Response(null, { status: 400 });
		}
		if (!body) return new Response(null, { status: 413 });

		const signature = parseSignature(request.headers.get('x-hub-signature-256'));
		if (!signature || !(await verifySignature(await key, body, signature))) {
			return new Response(null, { status: 401 });
		}

		const payload = parsePayload(body);
		if (!isRecord(payload)) return new Response(null, { status: 400 });

		const name = request.headers.get('x-github-event');
		const deliveryId = request.headers.get('x-github-delivery');
		if (!name || !deliveryId) return new Response(null, { status: 400 });
		if (name === 'ping') return new Response(null, { status: 200 });

		const delivery = {
			name: name as WebhookEventName,
			payload,
			deliveryId,
			hookId: readOptionalHeader(request.headers, 'x-github-hook-id'),
			installationTarget: readInstallationTarget(request.headers),
		} as GitHubWebhookDelivery;

		return serializeHandlerResult(await options.webhook({ c, delivery }));
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return new Response(null, { status: 200 });
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

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? '');
	if (!match) return undefined;
	const hex = match[1];
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

function parsePayload(body: Uint8Array): unknown {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readInstallationTarget(headers: Headers): { id: string; type: string } | undefined {
	const id = readOptionalHeader(headers, 'x-github-hook-installation-target-id');
	const type = readOptionalHeader(headers, 'x-github-hook-installation-target-type');
	return id && type ? { id, type } : undefined;
}

function readOptionalHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	return value && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
