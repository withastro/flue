import type { Env, Handler } from 'hono';
import type { HttpChannelOptions, HttpWebhookHandlerInput } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createHttpWebhookHandler<E extends Env>(
	options: HttpChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('HTTP webhook bodyLimit must be a positive integer.');
	}

	return async (c) => {
		const request = c.req.raw;
		const contentLength = request.headers.get('content-length');
		if (contentLength !== null && !/^\d+$/.test(contentLength)) return response(400);
		if (contentLength !== null && Number(contentLength) > bodyLimit) return response(413);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);

		let bodyString: string;
		try {
			bodyString = decoder.decode(body.value);
		} catch {
			return response(400);
		}

		if (options.verify) {
			try {
				const verified = await options.verify(request.headers, bodyString, body.value);
				if (Object.prototype.toString.call(verified) === '[object Response]') {
					return verified as Response;
				}
				if (!verified) return response(401);
			} catch {
				return response(401);
			}
		}

		let jsonPayload: unknown | undefined;
		if (isJsonRequest(request)) {
			try {
				jsonPayload = JSON.parse(bodyString);
			} catch {
				return response(400);
			}
		}

		const input: HttpWebhookHandlerInput<E> = {
			c,
			body: bodyString,
			rawBody: body.value,
			json: jsonPayload,
		};

		return serializeHandlerResult(await options.webhook(input));
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value);
}

function isJsonRequest(request: Request): boolean {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	return contentType === 'application/json';
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

function response(status: number): Response {
	return new Response(null, { status });
}
