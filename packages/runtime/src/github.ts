import { Hono } from 'hono';
import { InvalidRequestError, toHttpResponse, UnauthorizedError } from './errors.ts';
import { receiveExternalDelivery } from './runtime/flue-app.ts';
import type { ChannelDefinition, ChannelWebhookHandler } from './types.ts';
import { defineChannel } from './channels.ts';

export interface GitHubWebhookOptions {
	/** Shared webhook secret. Defaults to env.GITHUB_WEBHOOK_SECRET when omitted. */
	webhookSecret?: string;
}

export function createGitHubChannel(): () => ChannelDefinition<'github'> {
	return () => defineChannel('github');
}

export function createGitHubChannelRouter(options: GitHubWebhookOptions = {}): Hono {
	const app = new Hono();
	const webhook = createGitHubWebhook(options);
	app.post('/', async (c) => {
		const delivery = await webhook.receive(c.req.raw, c.env);
		const result = await receiveExternalDelivery(delivery);
		return c.json({ accepted: true, ...result }, 202);
	});
	app.onError((error) => toHttpResponse(error));
	return app;
}

export function createGitHubWebhook(options: GitHubWebhookOptions = {}): ChannelWebhookHandler {
	return {
		async receive(request, env) {
			if (request.method !== 'POST') {
				throw new InvalidRequestError({ reason: 'GitHub webhooks must use POST.' });
			}
			const deliveryId = requiredHeader(request, 'x-github-delivery');
			const event = requiredHeader(request, 'x-github-event');
			const signature = request.headers.get('x-hub-signature-256');
			const body = await request.text();
			const secret = options.webhookSecret ?? readEnvString(env, 'GITHUB_WEBHOOK_SECRET') ?? readProcessEnvString('GITHUB_WEBHOOK_SECRET');
			if (secret) {
				if (!signature) throw new UnauthorizedError({ reason: 'Missing GitHub webhook signature.' });
				if (!(await verifyGitHubSignature(body, secret, signature))) {
					throw new UnauthorizedError({ reason: 'Invalid GitHub webhook signature.' });
				}
			}

			let payload: unknown;
			try {
				payload = body ? JSON.parse(body) : null;
			} catch (error) {
				throw new InvalidRequestError({
					reason: `GitHub webhook body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				});
			}

			const objectPayload = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
			const data = compactObject({
				event,
				deliveryId,
				action: stringField(objectPayload.action),
				repository: objectPayload.repository,
				sender: objectPayload.sender,
				installation: objectPayload.installation,
				payload,
			});
			const raw = {
				headers: compactObject({
					'x-github-delivery': deliveryId,
					'x-github-event': event,
					'x-github-hook-id': request.headers.get('x-github-hook-id') ?? undefined,
					'x-github-hook-installation-target-id': request.headers.get('x-github-hook-installation-target-id') ?? undefined,
					'x-github-hook-installation-target-type': request.headers.get('x-github-hook-installation-target-type') ?? undefined,
				}),
				body,
				payload,
			};
			return {
				id: deliveryId,
				channel: 'github',
				type: event,
				data,
				raw,
			};
		},
	};
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}

function requiredHeader(request: Request, name: string): string {
	const value = request.headers.get(name);
	if (!value) throw new InvalidRequestError({ reason: `Missing required GitHub webhook header "${name}".` });
	return value;
}

function stringField(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function readEnvString(env: unknown, key: string): string | undefined {
	if (!env || typeof env !== 'object') return undefined;
	const value = (env as Record<string, unknown>)[key];
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function readProcessEnvString(key: string): string | undefined {
	const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
	const value = processLike.process?.env?.[key];
	return typeof value === 'string' && value !== '' ? value : undefined;
}

async function verifyGitHubSignature(body: string, secret: string, signature: string): Promise<boolean> {
	if (!signature.startsWith('sha256=')) return false;
	const expected = await hmacSha256Hex(secret, body);
	return timingSafeEqual(signature.slice('sha256='.length), expected);
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
