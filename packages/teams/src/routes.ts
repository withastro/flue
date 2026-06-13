import type { Context, Env, Handler } from 'hono';
import {
	BotFrameworkDiscoveryError,
	createBotFrameworkTokenVerifier,
	type BotFrameworkTokenVerifierOptions,
} from './auth.ts';
import type {
	JsonValue,
	TeamsAccountRef,
	TeamsActivity,
	TeamsActivityEnvelope,
	TeamsConversationRef,
	TeamsHandlerResult,
	TeamsMention,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 4_500;

interface TeamsActivitiesHandlerOptions<E extends Env> extends BotFrameworkTokenVerifierOptions {
	tenantId: string;
	bodyLimit?: number;
	handlerTimeoutMs?: number;
	activities(input: { c: Context<E>; activity: TeamsActivity }): TeamsHandlerResult;
}

export function createTeamsActivitiesHandler<E extends Env>(
	options: TeamsActivitiesHandlerOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Microsoft Teams route bodyLimit must be a positive integer.');
	}
	if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
		throw new TypeError('Microsoft Teams route handlerTimeoutMs must be a positive integer.');
	}
	if (handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS) {
		throw new TypeError('Microsoft Teams route handlerTimeoutMs must not exceed 4500ms.');
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

		const activity = normalizeActivity(raw, options.tenantId);
		if (!activity) return response(400);

		const outcome = await runHandler(() => options.activities({ c, activity }), handlerTimeoutMs);
		if (outcome.type !== 'success') return response(500);
		if (outcome.value instanceof Response) return outcome.value;
		if (outcome.value === undefined) return response(200);
		if (!isJsonValue(outcome.value)) return response(500);
		return Response.json(outcome.value);
	};
}

function normalizeActivity(
	raw: Record<string, unknown>,
	tenantId: string,
): TeamsActivity | undefined {
	const activityType = readString(raw, 'type');
	const serviceUrl = readString(raw, 'serviceUrl');
	const conversation = readRecord(raw, 'conversation');
	const conversationId = conversation && readString(conversation, 'id');
	const recipient = normalizeAccount(readRecord(raw, 'recipient'));
	const sender = normalizeAccount(readRecord(raw, 'from'));
	if (!activityType || !serviceUrl || !conversationId || !recipient) return undefined;
	if (!isHttpsServiceUrl(serviceUrl)) return undefined;

	const activityId = readAnyString(raw, 'id');
	const timestamp = readAnyString(raw, 'timestamp');
	const replyToId = readAnyString(raw, 'replyToId');
	const channelData = readRecord(raw, 'channelData');
	const teamId = readNestedId(channelData, 'team');
	const channelId = readNestedId(channelData, 'channel');
	const scope = normalizeScope(conversation, teamId, channelId);
	const threadId = scope === 'channel' ? (replyToId ?? activityId) : undefined;
	const destination: TeamsConversationRef = {
		tenantId,
		serviceUrl,
		conversationId,
		scope,
		botId: recipient.id,
		...(threadId === undefined ? {} : { threadId }),
		...(teamId === undefined ? {} : { teamId }),
		...(channelId === undefined ? {} : { channelId }),
	};
	const common: Omit<TeamsActivityEnvelope<string, never>, 'type' | 'payload' | 'raw'> = {
		...(activityId === undefined ? {} : { activityId }),
		...(timestamp === undefined ? {} : { timestamp }),
		tenantId,
		serviceUrl,
		destination,
		...(sender === undefined ? {} : { sender }),
		bot: recipient,
	};

	if (activityType === 'message') {
		const attachments = raw.attachments;
		const entities = raw.entities;
		if (
			(attachments !== undefined && !Array.isArray(attachments)) ||
			(entities !== undefined && !Array.isArray(entities))
		) {
			return undefined;
		}
		return {
			...common,
			type: 'message',
			payload: {
				...(readAnyString(raw, 'text') === undefined ? {} : { text: readAnyString(raw, 'text') }),
				...(readAnyString(raw, 'locale') === undefined
					? {}
					: { locale: readAnyString(raw, 'locale') }),
				attachments: attachments ?? [],
				mentions: normalizeMentions(entities ?? []),
				...(raw.value === undefined ? {} : { value: raw.value }),
			},
			raw,
		};
	}
	if (activityType === 'conversationUpdate') {
		const membersAdded = normalizeAccounts(raw.membersAdded);
		const membersRemoved = normalizeAccounts(raw.membersRemoved);
		if (!membersAdded || !membersRemoved) return undefined;
		return {
			...common,
			type: 'conversation_update',
			payload: {
				membersAdded,
				membersRemoved,
				...(readAnyString(raw, 'topicName') === undefined
					? {}
					: { topicName: readAnyString(raw, 'topicName') }),
			},
			raw,
		};
	}
	if (activityType === 'invoke') {
		const name = readString(raw, 'name');
		if (!name) return undefined;
		return {
			...common,
			type: 'invoke',
			payload: {
				name,
				...(raw.value === undefined ? {} : { value: raw.value }),
			},
			raw,
		};
	}
	if (activityType === 'messageReaction') {
		const reactionsAdded = normalizeReactions(raw.reactionsAdded);
		const reactionsRemoved = normalizeReactions(raw.reactionsRemoved);
		if (!reactionsAdded || !reactionsRemoved) return undefined;
		return {
			...common,
			type: 'message_reaction',
			payload: { reactionsAdded, reactionsRemoved },
			raw,
		};
	}
	return {
		...common,
		type: 'unknown',
		activityType,
		raw,
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

function normalizeAccount(value: Record<string, unknown> | undefined): TeamsAccountRef | undefined {
	if (!value) return undefined;
	const id = readString(value, 'id');
	if (!id) return undefined;
	const name = readAnyString(value, 'name');
	const aadObjectId = readAnyString(value, 'aadObjectId');
	return {
		id,
		...(name === undefined ? {} : { name }),
		...(aadObjectId === undefined ? {} : { aadObjectId }),
	};
}

function normalizeAccounts(value: unknown): readonly TeamsAccountRef[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const accounts = value.map((entry) => normalizeAccount(isRecord(entry) ? entry : undefined));
	return accounts.every((account): account is TeamsAccountRef => account !== undefined)
		? accounts
		: undefined;
}

function normalizeMentions(entities: readonly unknown[]): readonly TeamsMention[] {
	const mentions: TeamsMention[] = [];
	for (const entity of entities) {
		if (!isRecord(entity) || entity.type !== 'mention') continue;
		const mentioned = normalizeAccount(readRecord(entity, 'mentioned'));
		if (!mentioned) continue;
		const text = readAnyString(entity, 'text');
		mentions.push({
			mentioned,
			...(text === undefined ? {} : { text }),
		});
	}
	return mentions;
}

function normalizeReactions(value: unknown): readonly string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const reactions = value.map((entry) => (isRecord(entry) ? readString(entry, 'type') : undefined));
	return reactions.every((reaction): reaction is string => reaction !== undefined)
		? reactions
		: undefined;
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

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return true;
	}
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		const valid = value.every((entry) => isJsonValue(entry, seen));
		seen.delete(value);
		return valid;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		seen.delete(value);
		return false;
	}
	const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
	seen.delete(value);
	return valid;
}

async function runHandler<T>(
	handler: () => T | Promise<T>,
	timeoutMs: number,
): Promise<{ type: 'success'; value: T } | { type: 'failure' }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(handler()).then(
				(value) => ({ type: 'success' as const, value }),
				() => ({ type: 'failure' as const }),
			),
			new Promise<{ type: 'failure' }>((resolve) => {
				timer = setTimeout(() => resolve({ type: 'failure' }), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function response(status: number): Response {
	return new Response(null, { status });
}
