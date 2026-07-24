import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { Context, Env, Hono } from 'hono';
import type {
	GoogleChatInteractionAuthentication,
	GoogleChatPubSubAuthentication,
} from './auth.ts';
import { InvalidGoogleChatInputError, InvalidGoogleChatInstanceIdError } from './errors.ts';
import {
	createGoogleChatInteractionsHandler,
	createGoogleChatWorkspaceEventsHandler,
} from './routes.ts';

export type { JsonValue } from '@flue/runtime';
export type {
	GoogleChatInteractionAuthentication,
	GoogleChatPubSubAuthentication,
} from './auth.ts';
export { InvalidGoogleChatInputError, InvalidGoogleChatInstanceIdError } from './errors.ts';

export interface GoogleChatChannelOptions<E extends Env = Env> {
	/** Direct Google Chat request authentication and callback. */
	interactions?: {
		authentication: GoogleChatInteractionAuthentication;
		handler(input: GoogleChatInteractionHandlerInput<E>): GoogleChatHandlerResult;
	};
	/** Optional authenticated Pub/Sub push surface for Google Workspace Events. */
	workspaceEvents?: {
		authentication: GoogleChatPubSubAuthentication;
		handler(input: GoogleChatWorkspaceEventHandlerInput<E>): GoogleChatHandlerResult;
	};
	/** Fetch implementation used only for Google signing-key discovery. */
	fetch?: typeof globalThis.fetch;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
}

export interface GoogleChatConversationRef {
	/** Google Chat space resource name in `spaces/<id>` form. */
	space: string;
	/** Optional thread resource name in `spaces/<id>/threads/<id>` form. */
	thread?: string;
	spaceType?: GoogleChatSpaceType;
}

export type GoogleChatSpaceType = 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE' | (string & {});

export type GoogleChatDeprecatedSpaceType = 'ROOM' | 'DM' | (string & {});

export interface GoogleChatSpace {
	name?: string;
	spaceType?: GoogleChatSpaceType;
	type?: GoogleChatDeprecatedSpaceType;
	[key: string]: unknown;
}

export interface GoogleChatThread {
	name?: string;
	[key: string]: unknown;
}

export interface GoogleChatUser {
	name?: string;
	displayName?: string;
	type?: string;
	domainId?: string;
	[key: string]: unknown;
}

export interface GoogleChatMessage {
	name?: string;
	text?: string;
	argumentText?: string;
	formattedText?: string;
	space?: GoogleChatSpace;
	thread?: GoogleChatThread;
	attachment?: readonly unknown[];
	annotations?: readonly unknown[];
	[key: string]: unknown;
}

export interface GoogleChatAction {
	actionMethodName?: string;
	parameters?: readonly { key?: string; value?: string; [key: string]: unknown }[];
	[key: string]: unknown;
}

export type GoogleChatInteractionType =
	| 'MESSAGE'
	| 'ADDED_TO_SPACE'
	| 'REMOVED_FROM_SPACE'
	| 'CARD_CLICKED'
	| 'APP_COMMAND'
	| 'APP_HOME'
	| 'SUBMIT_FORM'
	| 'WIDGET_UPDATED'
	| (string & {});

export interface GoogleChatInteraction {
	type: GoogleChatInteractionType;
	eventTime?: string;
	user?: GoogleChatUser;
	space?: GoogleChatSpace;
	message?: GoogleChatMessage;
	thread?: GoogleChatThread;
	action?: GoogleChatAction;
	appCommandMetadata?: Record<string, unknown>;
	common?: Record<string, unknown>;
	[key: string]: unknown;
}

export type GoogleChatWorkspaceEventType =
	| 'google.workspace.chat.message.v1.created'
	| 'google.workspace.chat.message.v1.updated'
	| 'google.workspace.chat.message.v1.deleted'
	| 'google.workspace.chat.message.v1.batchCreated'
	| 'google.workspace.chat.message.v1.batchUpdated'
	| 'google.workspace.chat.message.v1.batchDeleted'
	| 'google.workspace.chat.membership.v1.created'
	| 'google.workspace.chat.membership.v1.updated'
	| 'google.workspace.chat.membership.v1.deleted'
	| 'google.workspace.chat.membership.v1.batchCreated'
	| 'google.workspace.chat.membership.v1.batchUpdated'
	| 'google.workspace.chat.membership.v1.batchDeleted'
	| 'google.workspace.chat.reaction.v1.created'
	| 'google.workspace.chat.reaction.v1.deleted'
	| 'google.workspace.chat.reaction.v1.batchCreated'
	| 'google.workspace.chat.reaction.v1.batchDeleted'
	| 'google.workspace.chat.space.v1.updated'
	| 'google.workspace.chat.space.v1.deleted'
	| 'google.workspace.chat.space.v1.batchUpdated'
	| 'google.workspace.events.subscription.v1.suspended'
	| 'google.workspace.events.subscription.v1.expirationReminder'
	| 'google.workspace.events.subscription.v1.expired'
	| (string & {});

export interface GoogleChatCloudEventAttributes {
	'ce-datacontenttype': 'application/json';
	'ce-id': string;
	'ce-source': string;
	'ce-specversion': '1.0';
	'ce-subject': string;
	'ce-type': GoogleChatWorkspaceEventType;
	'ce-time'?: string;
	[key: string]: string | undefined;
}

export interface GoogleChatPubSubMessage {
	attributes: GoogleChatCloudEventAttributes;
	data: string;
	messageId: string;
	publishTime?: string;
	orderingKey?: string;
	[key: string]: unknown;
}

export interface GoogleChatWorkspaceEventDelivery {
	message: GoogleChatPubSubMessage;
	subscription: string;
	deliveryAttempt?: number;
	[key: string]: unknown;
}

export type GoogleChatHandlerResult =
	undefined | JsonValue | Response | Promise<undefined | JsonValue | Response>;

export interface GoogleChatInteractionHandlerInput<E extends Env = Env> {
	c: Context<E>;
	payload: GoogleChatInteraction;
}

export interface GoogleChatWorkspaceEventHandlerInput<E extends Env = Env> {
	c: Context<E>;
	delivery: GoogleChatWorkspaceEventDelivery;
}

export interface GoogleChatChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/google-chat', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id: a canonical namespaced identifier. It is not an authorization capability. */
	instanceId(ref: GoogleChatConversationRef): string;
	/**
	 * Parses only canonical instance ids produced by `instanceId()`. Escape hatch: agents
	 * normally receive structured facts as creation data rather than parsing them from the id.
	 */
	parseInstanceId(id: string): GoogleChatConversationRef;
}

/**
 * Creates verified Google Chat interaction and optional Workspace Event routes.
 *
 * At least one surface is required. Omitted surfaces do not publish routes.
 */
export function createGoogleChatChannel<E extends Env = Env>(
	options: GoogleChatChannelOptions<E>,
): GoogleChatChannel<E> {
	validateOptions(options);
	const routes: ChannelRouteDefinition<E>[] = [];
	if (options.interactions) {
		routes.push({
			method: 'POST',
			path: '/interactions',
			handler: createGoogleChatInteractionsHandler({
				authentication: options.interactions.authentication,
				handler: options.interactions.handler,
				fetch: options.fetch,
				bodyLimit: options.bodyLimit,
			}),
		});
	}
	if (options.workspaceEvents) {
		routes.push({
			method: 'POST',
			path: '/events',
			handler: createGoogleChatWorkspaceEventsHandler({
				authentication: options.workspaceEvents.authentication,
				handler: options.workspaceEvents.handler,
				fetch: options.fetch,
				bodyLimit: options.bodyLimit,
			}),
		});
	}

	const channel: GoogleChatChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertConversationRef(ref);
			return [
				'google-chat',
				'v1',
				encodeURIComponent(ref.space),
				encodeURIComponent(ref.thread ?? ''),
			].join(':');
		},
		parseInstanceId(id) {
			try {
				const parts = id.split(':');
				if (parts.length !== 4 || parts[0] !== 'google-chat' || parts[1] !== 'v1') {
					throw new InvalidGoogleChatInstanceIdError();
				}
				const ref: GoogleChatConversationRef = {
					space: decodeURIComponent(requiredPart(parts[2])),
					...(parts[3] ? { thread: decodeURIComponent(parts[3]) } : {}),
				};
				assertConversationRef(ref);
				if (channel.instanceId(ref) !== id) {
					throw new InvalidGoogleChatInstanceIdError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidGoogleChatInstanceIdError) throw error;
				throw new InvalidGoogleChatInstanceIdError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: GoogleChatChannelOptions<E>): void {
	if (!options || typeof options !== 'object') throw new InvalidGoogleChatInputError('options');
	if (!options.interactions && !options.workspaceEvents) {
		throw new InvalidGoogleChatInputError('interactions or workspaceEvents');
	}
	if (options.fetch !== undefined && typeof options.fetch !== 'function') {
		throw new InvalidGoogleChatInputError('fetch');
	}
	if (options.interactions) {
		validateInteractionAuthentication(options.interactions.authentication);
		if (typeof options.interactions.handler !== 'function') {
			throw new InvalidGoogleChatInputError('interactions.handler');
		}
	}
	if (options.workspaceEvents) {
		validatePubSubAuthentication(options.workspaceEvents.authentication);
		if (typeof options.workspaceEvents.handler !== 'function') {
			throw new InvalidGoogleChatInputError('workspaceEvents.handler');
		}
	}
}

function validateInteractionAuthentication(
	authentication: GoogleChatInteractionAuthentication,
): void {
	if (!authentication || typeof authentication !== 'object') {
		throw new InvalidGoogleChatInputError('interactions.authentication');
	}
	if (authentication.type === 'endpoint-url') {
		assertHttpsUrl(authentication.audience, 'interactions.authentication.audience');
		if (authentication.jwksUrl !== undefined) {
			assertHttpsUrl(authentication.jwksUrl, 'interactions.authentication.jwksUrl');
		}
		return;
	}
	if (authentication.type === 'project-number') {
		if (!/^\d+$/.test(authentication.projectNumber)) {
			throw new InvalidGoogleChatInputError('interactions.authentication.projectNumber');
		}
		if (authentication.certificatesUrl !== undefined) {
			assertHttpsUrl(authentication.certificatesUrl, 'interactions.authentication.certificatesUrl');
		}
		return;
	}
	throw new InvalidGoogleChatInputError('interactions.authentication.type');
}

function validatePubSubAuthentication(authentication: GoogleChatPubSubAuthentication): void {
	if (!authentication || typeof authentication !== 'object') {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication');
	}
	if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(authentication.subscription)) {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication.subscription');
	}
	assertNonEmpty(authentication.audience, 'workspaceEvents.authentication.audience');
	if (!authentication.serviceAccountEmail.includes('@')) {
		throw new InvalidGoogleChatInputError('workspaceEvents.authentication.serviceAccountEmail');
	}
	if (authentication.jwksUrl !== undefined) {
		assertHttpsUrl(authentication.jwksUrl, 'workspaceEvents.authentication.jwksUrl');
	}
}

function assertConversationRef(ref: GoogleChatConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidGoogleChatInputError('ref');
	if (!/^spaces\/[^/]+$/.test(ref.space)) throw new InvalidGoogleChatInputError('ref.space');
	if (ref.thread !== undefined) {
		const match = /^(spaces\/[^/]+)\/threads\/[^/]+$/.exec(ref.thread);
		if (!match || match[1] !== ref.space) throw new InvalidGoogleChatInputError('ref.thread');
	}
	if (ref.spaceType !== undefined && typeof ref.spaceType !== 'string') {
		throw new InvalidGoogleChatInputError('ref.spaceType');
	}
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new InvalidGoogleChatInputError(field);
	}
}

function assertHttpsUrl(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string') throw new InvalidGoogleChatInputError(field);
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.username !== '' ||
			url.password !== '' ||
			url.hash !== ''
		) {
			throw new InvalidGoogleChatInputError(field);
		}
	} catch (error) {
		if (error instanceof InvalidGoogleChatInputError) throw error;
		throw new InvalidGoogleChatInputError(field);
	}
}

function requiredPart(value: string | undefined): string {
	if (!value) throw new InvalidGoogleChatInstanceIdError();
	return value;
}
