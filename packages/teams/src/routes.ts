import type { Activity } from 'botframework-schema';
import type { Context, Env, Handler } from 'hono';
import {
	BotFrameworkDiscoveryError,
	type BotFrameworkTokenVerifierOptions,
	createBotFrameworkTokenVerifier,
} from './auth.ts';
import type { TeamsConversationRef, TeamsHandlerResult } from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;

interface TeamsActivitiesHandlerOptions<E extends Env> extends BotFrameworkTokenVerifierOptions {
	tenantId: string;
	bodyLimit?: number;
	activities(input: { c: Context<E>; activity: Activity }): TeamsHandlerResult;
}

export function createTeamsActivitiesHandler<E extends Env>(
	options: TeamsActivitiesHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Microsoft Teams route bodyLimit must be a positive integer.');
	}
	const verifyToken = createBotFrameworkTokenVerifier(options);

	return async (c) => {
		const request = c.req.raw;
		const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		if (mediaType !== 'application/json') return response(415);

		const contentLength = request.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^\d+$/.test(contentLength)) return response(400);
			if (Number(contentLength) > bodyLimit) return response(413);
		}

		let verifiedToken: Awaited<ReturnType<typeof verifyToken>>;
		try {
			verifiedToken = await verifyToken(request.headers.get('authorization'));
		} catch (error) {
			return response(error instanceof BotFrameworkDiscoveryError ? 503 : 401);
		}

		let body: Uint8Array | undefined;
		try {
			body = await readBody(request, bodyLimit);
		} catch {
			return response(400);
		}
		if (!body) return response(413);

		const raw = parseJson(body);
		if (!isRecord(raw)) return response(400);
		if (raw.channelId !== 'msteams') return response(403);
		if (!verifiedToken.endorsements.includes('msteams')) return response(401);
		if (raw.serviceUrl !== verifiedToken.serviceUrl) return response(401);

		const tenantIds = collectTenantIds(raw);
		if (!tenantIds || tenantIds.length === 0) return response(400);
		if (tenantIds.some((tenantId) => tenantId !== options.tenantId)) return response(403);

		if (!deriveDestination(raw, options.tenantId)) return response(400);

		return serializeHandlerResult(
			await options.activities({ c, activity: raw as unknown as Activity }),
		);
	};
}

function serializeHandlerResult(value: unknown): Response {
	if (value === undefined) return response(200);
	if (Object.prototype.toString.call(value) === '[object Response]') return value as Response;
	return Response.json(value as Parameters<typeof Response.json>[0]);
}

/**
 * Derives the canonical routing identity from a verified Teams activity. Returns
 * `undefined` when the activity lacks the minimal structure the channel needs
 * to address replies. This validation is limited to ingress identity; it does
 * not reshape the provider-native payload handed to the application.
 */
export function deriveDestination(
	raw: Record<string, unknown>,
	tenantId: string,
): TeamsConversationRef | undefined {
	const serviceUrl = readString(raw, 'serviceUrl');
	const conversation = readRecord(raw, 'conversation');
	const conversationId = conversation && readString(conversation, 'id');
	const recipient = readRecord(raw, 'recipient');
	const botId = recipient && readString(recipient, 'id');
	if (!serviceUrl || !conversationId || !botId) return undefined;
	if (!isHttpsServiceUrl(serviceUrl)) return undefined;

	const activityId = readAnyString(raw, 'id');
	const replyToId = readAnyString(raw, 'replyToId');
	const channelData = readRecord(raw, 'channelData');
	const teamId = readNestedId(channelData, 'team');
	const channelId = readNestedId(channelData, 'channel');
	const scope = normalizeScope(conversation, teamId, channelId);
	const threadId = scope === 'channel' ? (replyToId ?? activityId) : undefined;
	return {
		tenantId,
		serviceUrl,
		conversationId,
		scope,
		botId,
		...(threadId === undefined ? {} : { threadId }),
		...(teamId === undefined ? {} : { teamId }),
		...(channelId === undefined ? {} : { channelId }),
	};
}

function collectTenantIds(raw: Record<string, unknown>): string[] | undefined {
	const values: unknown[] = [];
	const conversation = readRecord(raw, 'conversation');
	const channelData = readRecord(raw, 'channelData');
	const channelTenant = channelData && readRecord(channelData, 'tenant');
	for (const [record, field] of [
		[conversation, 'tenantId'],
		[channelTenant, 'id'],
	] as const) {
		if (!record || record[field] === undefined) continue;
		if (typeof record[field] !== 'string' || record[field].length === 0) return undefined;
		values.push(record[field]);
	}
	return values as string[];
}

function normalizeScope(
	conversation: Record<string, unknown>,
	teamId: string | undefined,
	channelId: string | undefined,
): TeamsConversationRef['scope'] {
	const conversationType = readAnyString(conversation, 'conversationType');
	if (conversationType === 'personal') return 'personal';
	if (conversationType === 'groupChat') return 'groupChat';
	if (conversationType === 'channel' || teamId || channelId) return 'channel';
	return 'unknown';
}

function readNestedId(
	value: Record<string, unknown> | undefined,
	field: string,
): string | undefined {
	const nested = value && readRecord(value, field);
	return nested && readAnyString(nested, 'id');
}

function isHttpsServiceUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			url.search === '' &&
			url.hash === ''
		);
	} catch {
		return false;
	}
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
	} catch {
		return undefined;
	}
}

function readRecord(
	record: Record<string, unknown> | undefined,
	field: string,
): Record<string, unknown> | undefined {
	const value = record?.[field];
	return isRecord(value) ? value : undefined;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readAnyString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function response(status: number): Response {
	return new Response(null, { status });
}
