import type { Env, Handler } from 'hono';
import type { ResendChannelOptions, ResendWebhookDelivery, ResendWebhookEvent } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createResendWebhookHandler<E extends Env>(
	options: ResendChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Resend webhook bodyLimit must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const delivery = readDelivery(request.headers);
		const signature = request.headers.get('svix-signature');
		if (!delivery || !signature) return response(400);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		let payload: string;
		try {
			payload = decoder.decode(body.value);
		} catch {
			return response(400);
		}

		let verified: unknown;
		try {
			// The official verifier checks the Svix signature and timestamp window
			// over the exact bytes, then returns the parsed provider payload.
			verified = options.client.webhooks.verify({
				payload,
				headers: {
					id: delivery.id,
					timestamp: delivery.timestamp,
					signature,
				},
				webhookSecret: options.webhookSecret,
			});
		} catch {
			return response(400);
		}

		// Forward the provider-native payload unmodified. Require only the minimal
		// structure the handler dispatches on (`event.type`); the channel does not
		// re-validate event-family shapes the official types already describe.
		if (!isRecord(verified) || readNonEmptyString(verified, 'type') === undefined) {
			return response(400);
		}
		const event = verified as unknown as ResendWebhookEvent;
		return serializeHandlerResult(await options.webhook({ c, event, delivery }));
	};
}

function readDelivery(headers: Headers): ResendWebhookDelivery | undefined {
	const id = headers.get('svix-id');
	const timestamp = headers.get('svix-timestamp');
	if (!id || !timestamp || !/^\d+$/.test(timestamp)) return undefined;
	const seconds = Number(timestamp);
	if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
	return { id, timestamp };
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

function readNonEmptyString(value: Record<string, unknown>, key: string): string | undefined {
	const result = value[key];
	return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
