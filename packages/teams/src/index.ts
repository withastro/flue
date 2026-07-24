import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Activity } from 'botframework-schema';
import type { Context, Env, Hono } from 'hono';
import { defaultBotFrameworkOpenIdMetadataUrl, defaultBotFrameworkTokenIssuer } from './auth.ts';
import { InvalidTeamsInputError, InvalidTeamsInstanceIdError } from './errors.ts';
import { createTeamsActivitiesHandler, deriveDestination } from './routes.ts';

export type { JsonValue } from '@flue/runtime';
/**
 * Provider-native Bot Framework activity payload, re-exported from the official
 * `botframework-schema` package. Microsoft Teams delivers these to the
 * activities endpoint with their documented field names and nesting.
 */
export type {
	Activity,
	Attachment,
	ChannelAccount,
	ConversationAccount,
	Entity,
	Mention,
	MessageReaction,
} from 'botframework-schema';
export { InvalidTeamsInputError, InvalidTeamsInstanceIdError } from './errors.ts';

/** Ingress configuration for one fixed Microsoft Teams application and tenant. */
export interface TeamsChannelOptions<E extends Env = Env> {
	/** Microsoft Entra application id expected in Bot Connector access tokens. */
	appId: string;
	/** Expected Microsoft Teams tenant id from verified activities. */
	tenantId: string;
	/** Bot Framework OpenID metadata URL. Defaults to the public-cloud endpoint. */
	openIdMetadataUrl?: string;
	/** Expected Bot Connector token issuer. Defaults to https://api.botframework.com. */
	tokenIssuer?: string;
	/** Fetch implementation used only for OpenID metadata and signing-key discovery. */
	fetch?: typeof globalThis.fetch;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives verified provider-native Bot Framework activities. */
	activities(input: TeamsActivitiesHandlerInput<E>): TeamsHandlerResult;
}

/** Stable routing identity derived from one verified Teams activity. */
export interface TeamsConversationRef {
	tenantId: string;
	serviceUrl: string;
	conversationId: string;
	scope: 'personal' | 'groupChat' | 'channel' | 'unknown';
	botId: string;
	threadId?: string;
	teamId?: string;
	channelId?: string;
}

type TeamsHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing produces an empty `200`. JSON-compatible values become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type TeamsHandlerResult = TeamsHandlerValue | Promise<TeamsHandlerValue>;

/** Input delivered to the activities callback after request authentication. */
export interface TeamsActivitiesHandlerInput<E extends Env = Env> {
	c: Context<E>;
	/** Provider-native Bot Framework activity, verified but otherwise unmodified. */
	activity: Activity;
}

/** Verified activities and canonical identity helpers. */
export interface TeamsChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/teams', channel.route())`.
	 */
	route(): Hono<E>;
	/**
	 * Derives the canonical routing identity from a verified activity. Verified
	 * activities delivered to the `activities` callback always derive a
	 * destination; throws `InvalidTeamsInputError` for an activity that lacks the
	 * minimal structure needed to address a reply.
	 */
	destination(activity: Activity): TeamsConversationRef;
	/**
	 * Derives the agent instance id: a canonical namespaced identifier. It is
	 * not an authorization capability.
	 */
	instanceId(ref: TeamsConversationRef): string;
	/**
	 * Parses only canonical ids produced by `instanceId()`. Escape hatch:
	 * agents normally receive structured facts as creation data rather than
	 * parsing them from the id.
	 */
	parseInstanceId(id: string): TeamsConversationRef;
}

/**
 * Creates a fixed-application, fixed-tenant Microsoft Teams activity channel.
 *
 * Bot Connector JWTs are verified through OpenID metadata and endorsed signing
 * keys before the provider-native activity is passed to the application. The
 * channel does not deduplicate retried deliveries.
 */
export function createTeamsChannel<E extends Env = Env>(
	options: TeamsChannelOptions<E>,
): TeamsChannel<E> {
	validateOptions(options);
	const handler = createTeamsActivitiesHandler({
		appId: options.appId,
		tenantId: options.tenantId,
		openIdMetadataUrl: options.openIdMetadataUrl,
		tokenIssuer: options.tokenIssuer,
		fetch: options.fetch,
		bodyLimit: options.bodyLimit,
		activities: options.activities,
	});

	const routes: readonly ChannelRouteDefinition<E>[] = [
		{ method: 'POST', path: '/activities', handler },
	];
	const channel: TeamsChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		destination(activity) {
			if (!activity || typeof activity !== 'object') throw new InvalidTeamsInputError('activity');
			const ref = deriveDestination(
				activity as unknown as Record<string, unknown>,
				options.tenantId,
			);
			if (!ref) throw new InvalidTeamsInputError('activity');
			return ref;
		},
		instanceId(ref) {
			assertConversationRef(ref);
			return [
				'teams',
				'v1',
				encodeURIComponent(ref.tenantId),
				ref.scope,
				encodeURIComponent(ref.serviceUrl),
				encodeURIComponent(ref.conversationId),
				encodeURIComponent(ref.botId),
				encodeURIComponent(ref.threadId ?? ''),
				encodeURIComponent(ref.teamId ?? ''),
				encodeURIComponent(ref.channelId ?? ''),
			].join(':');
		},
		parseInstanceId(id) {
			try {
				const parts = id.split(':');
				if (parts.length !== 10 || parts[0] !== 'teams' || parts[1] !== 'v1') {
					throw new InvalidTeamsInstanceIdError();
				}
				const scope = parts[3];
				if (
					scope !== 'personal' &&
					scope !== 'groupChat' &&
					scope !== 'channel' &&
					scope !== 'unknown'
				) {
					throw new InvalidTeamsInstanceIdError();
				}
				const ref: TeamsConversationRef = {
					tenantId: decodeURIComponent(requiredPart(parts[2])),
					scope,
					serviceUrl: decodeURIComponent(requiredPart(parts[4])),
					conversationId: decodeURIComponent(requiredPart(parts[5])),
					botId: decodeURIComponent(requiredPart(parts[6])),
					...(parts[7] ? { threadId: decodeURIComponent(parts[7]) } : {}),
					...(parts[8] ? { teamId: decodeURIComponent(parts[8]) } : {}),
					...(parts[9] ? { channelId: decodeURIComponent(parts[9]) } : {}),
				};
				assertConversationRef(ref);
				if (channel.instanceId(ref) !== id) throw new InvalidTeamsInstanceIdError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidTeamsInstanceIdError) throw error;
				throw new InvalidTeamsInstanceIdError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: TeamsChannelOptions<E>): void {
	if (!options || typeof options !== 'object') throw new InvalidTeamsInputError('options');
	assertIdentifier(options.appId, 'appId');
	assertIdentifier(options.tenantId, 'tenantId');
	if (typeof options.activities !== 'function') throw new InvalidTeamsInputError('activities');
	if (options.fetch !== undefined && typeof options.fetch !== 'function') {
		throw new InvalidTeamsInputError('fetch');
	}
	assertConfiguredUrl(
		options.openIdMetadataUrl ?? defaultBotFrameworkOpenIdMetadataUrl(),
		'openIdMetadataUrl',
	);
	assertConfiguredUrl(options.tokenIssuer ?? defaultBotFrameworkTokenIssuer(), 'tokenIssuer');
}

function assertConversationRef(ref: TeamsConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidTeamsInputError('ref');
	assertIdentifier(ref.tenantId, 'ref.tenantId');
	assertIdentifier(ref.conversationId, 'ref.conversationId');
	assertIdentifier(ref.botId, 'ref.botId');
	if (!['personal', 'groupChat', 'channel', 'unknown'].includes(ref.scope)) {
		throw new InvalidTeamsInputError('ref.scope');
	}
	assertConfiguredUrl(ref.serviceUrl, 'ref.serviceUrl');
	for (const [field, value] of [
		['ref.threadId', ref.threadId],
		['ref.teamId', ref.teamId],
		['ref.channelId', ref.channelId],
	] as const) {
		if (value !== undefined) assertIdentifier(value, field);
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new InvalidTeamsInputError(field);
	}
}

function assertConfiguredUrl(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string') throw new InvalidTeamsInputError(field);
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.username !== '' ||
			url.password !== '' ||
			url.hash !== ''
		) {
			throw new InvalidTeamsInputError(field);
		}
	} catch (error) {
		if (error instanceof InvalidTeamsInputError) throw error;
		throw new InvalidTeamsInputError(field);
	}
}

function requiredPart(value: string | undefined): string {
	if (!value) throw new InvalidTeamsInstanceIdError();
	return value;
}
