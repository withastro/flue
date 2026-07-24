import type { Context, Env, Handler } from 'hono';
import type Stripe from 'stripe';
import type {
	StripeChannelOptions,
	StripeSnapshotChannelOptions,
	StripeThinChannelOptions,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function createStripeWebhookHandler<E extends Env>(
	options: StripeChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Stripe webhook bodyLimit must be a positive integer.');
	}
	const signatureToleranceSeconds = options.signatureToleranceSeconds;
	if (
		signatureToleranceSeconds !== undefined &&
		(!Number.isSafeInteger(signatureToleranceSeconds) || signatureToleranceSeconds <= 0)
	) {
		throw new TypeError('Stripe webhook signatureToleranceSeconds must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (!isJsonRequest(request)) return response(415);
		if (contentLength !== null && Number(contentLength) > bodyLimit) {
			return response(413);
		}

		const signature = request.headers.get('stripe-signature');
		if (!signature) return response(400);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		if (options.eventPayload === 'thin') {
			return handleThinEvent(options, c, body.value, signature);
		}
		return handleSnapshotEvent(options, c, body.value, signature);
	};
}

async function handleSnapshotEvent<E extends Env>(
	options: StripeSnapshotChannelOptions<E>,
	c: Context<E>,
	body: Uint8Array,
	signature: string,
): Promise<Response> {
	let event: Stripe.Event;
	try {
		event = await options.client.webhooks.constructEventAsync(
			body,
			signature,
			options.webhookSecret,
			options.signatureToleranceSeconds,
		);
	} catch {
		return response(400);
	}
	// The official SDK already verified the signature and parsed the event; only
	// guard that the payload matches the configured mode (snapshot, not thin).
	if ((event as { object?: unknown }).object !== 'event') return response(400);
	return serializeHandlerResult(await options.webhook({ c, event }));
}

async function handleThinEvent<E extends Env>(
	options: StripeThinChannelOptions<E>,
	c: Context<E>,
	body: Uint8Array,
	signature: string,
): Promise<Response> {
	let event: Stripe.V2.Core.EventNotification;
	try {
		event = await options.client.parseEventNotificationAsync(
			body,
			signature,
			options.webhookSecret,
			options.signatureToleranceSeconds,
		);
	} catch {
		return response(400);
	}
	// The official SDK already verified the signature and parsed the notification;
	// only guard that the payload matches the configured mode (thin, not snapshot).
	if ((event as { object?: unknown }).object !== 'v2.core.event') return response(400);
	return serializeHandlerResult(await options.webhook({ c, event }));
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
