import { type ChannelRouteDefinition, createChannelRouter, type JsonValue } from '@flue/runtime';
import type { SlackEvent } from '@slack/types';
import type { Context, Env, Hono } from 'hono';
import { InvalidSlackInputError, InvalidSlackInstanceIdError } from './errors.ts';
import {
	createSlackCommandsHandler,
	createSlackEventsHandler,
	createSlackInteractionsHandler,
} from './routes.ts';

export type { JsonValue } from '@flue/runtime';
export { InvalidSlackInputError, InvalidSlackInstanceIdError } from './errors.ts';
export type { SlackEvent };

/** Ingress configuration for one Slack application. */
export interface SlackChannelOptions<E extends Env = Env> {
	/** Secret used to verify exact Slack request bytes. */
	signingSecret: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives provider-native Events API payloads. Omit it to omit `/events`. */
	events?(input: SlackEventsHandlerInput<E>): SlackHandlerResult;
	/** Receives provider-native interactivity payloads. Omit it to omit `/interactions`. */
	interactions?(input: SlackInteractionsHandlerInput<E>): SlackHandlerResult;
	/** Receives provider-native slash-command fields. Omit it to omit `/commands`. */
	commands?(input: SlackCommandsHandlerInput<E>): SlackHandlerResult;
}

/** Canonical Slack thread destination including its workspace identity. */
export interface SlackThreadRef {
	teamId: string;
	channelId: string;
	threadTs: string;
}

export interface SlackAuthorization {
	enterprise_id: string | null;
	team_id: string | null;
	user_id: string;
	is_bot: boolean;
	is_enterprise_install?: boolean;
}

/** Provider-native Events API callback envelope. */
export interface SlackEventCallbackPayload {
	token: string;
	team_id: string;
	enterprise_id?: string | null;
	context_team_id?: string;
	context_enterprise_id?: string | null;
	api_app_id: string;
	event: SlackEvent;
	type: 'event_callback';
	event_id: string;
	event_time: number;
	event_context?: string;
	is_ext_shared_channel?: boolean;
	authorizations?: SlackAuthorization[];
}

/** Provider-native rate-limit notification sent to the Events API endpoint. */
export type SlackAppRateLimitedPayload = Extract<SlackEvent, { type: 'app_rate_limited' }>;

/** Provider-native payload delivered to the Events API callback. */
export type SlackEventsApiPayload = SlackEventCallbackPayload | SlackAppRateLimitedPayload;

export interface SlackTeam {
	id: string;
	domain?: string;
	enterprise_id?: string;
	enterprise_name?: string;
}

export interface SlackUser {
	id: string;
	name?: string;
	username?: string;
	team_id?: string;
}

export interface SlackEnterprise {
	id: string;
	name?: string;
}

export interface SlackBlockAction {
	type: string;
	action_id: string;
	block_id?: string;
	action_ts?: string;
	value?: string;
	[key: string]: unknown;
}

export interface SlackBlockActionsPayload {
	type: 'block_actions';
	actions: SlackBlockAction[];
	team: SlackTeam | null;
	user: SlackUser;
	api_app_id: string;
	token?: string;
	trigger_id?: string;
	response_url?: string;
	container: Record<string, unknown>;
	channel?: Record<string, unknown>;
	message?: Record<string, unknown>;
	view?: Record<string, unknown>;
	is_enterprise_install?: boolean;
	enterprise?: SlackEnterprise;
	[key: string]: unknown;
}

export interface SlackViewSubmissionPayload {
	type: 'view_submission';
	team: SlackTeam | null;
	user: SlackUser;
	view: Record<string, unknown>;
	api_app_id: string;
	token?: string;
	trigger_id?: string;
	is_enterprise_install?: boolean;
	enterprise?: SlackEnterprise;
	response_urls?: Array<{
		block_id: string;
		action_id: string;
		channel_id: string;
		response_url: string;
	}>;
	[key: string]: unknown;
}

export interface SlackViewClosedPayload {
	type: 'view_closed';
	team: SlackTeam | null;
	user: SlackUser;
	view: Record<string, unknown>;
	api_app_id: string;
	token?: string;
	is_cleared: boolean;
	is_enterprise_install?: boolean;
	enterprise?: SlackEnterprise;
	[key: string]: unknown;
}

export interface SlackShortcutPayload {
	type: 'shortcut';
	callback_id: string;
	trigger_id: string;
	user: SlackUser;
	team: SlackTeam | null;
	api_app_id?: string;
	token?: string;
	action_ts?: string;
	is_enterprise_install?: boolean;
	enterprise?: SlackEnterprise;
	[key: string]: unknown;
}

export interface SlackMessageActionPayload {
	type: 'message_action';
	callback_id: string;
	trigger_id: string;
	message_ts: string;
	response_url: string;
	message: Record<string, unknown>;
	user: SlackUser;
	channel: Record<string, unknown>;
	team: SlackTeam | null;
	api_app_id?: string;
	token?: string;
	action_ts?: string;
	is_enterprise_install?: boolean;
	enterprise?: SlackEnterprise;
	[key: string]: unknown;
}

export interface SlackBlockSuggestionPayload {
	type: 'block_suggestion';
	action_id: string;
	block_id: string;
	value: string;
	team: SlackTeam | null;
	user: SlackUser;
	api_app_id?: string;
	channel?: Record<string, unknown>;
	view?: Record<string, unknown>;
	token?: string;
	[key: string]: unknown;
}

/**
 * Provider-native JSON payload delivered to the interactivity callback.
 *
 * The current union covers Slack's documented HTTP interaction families.
 * Authenticated future interaction types are still forwarded at runtime.
 */
export type SlackInteractionPayload =
	| SlackBlockActionsPayload
	| SlackViewSubmissionPayload
	| SlackViewClosedPayload
	| SlackShortcutPayload
	| SlackMessageActionPayload
	| SlackBlockSuggestionPayload;

/** Provider-native URL-encoded slash-command payload. */
export interface SlackSlashCommandPayload {
	token?: string;
	command: string;
	text: string;
	response_url: string;
	trigger_id: string;
	user_id: string;
	user_name?: string;
	team_id: string;
	team_domain?: string;
	channel_id: string;
	channel_name?: string;
	api_app_id: string;
	enterprise_id?: string;
	enterprise_name?: string;
	is_enterprise_install?: string;
	[key: string]: unknown;
}

type SlackHandlerValue = undefined | JsonValue | Response;

/**
 * Returning nothing produces an empty `200`. JSON-compatible values become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type SlackHandlerResult = SlackHandlerValue | Promise<SlackHandlerValue>;

/** Input for the optional Events API route. */
export interface SlackEventsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	payload: SlackEventsApiPayload;
}

/** Input for the optional interactivity route. */
export interface SlackInteractionsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	payload: SlackInteractionPayload;
}

/** Input for the optional slash-command route. */
export interface SlackCommandsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	payload: SlackSlashCommandPayload;
}

/** Verified ingress and canonical identity helpers. */
export interface SlackChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/slack', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id: a canonical namespaced identifier. It is not an authorization capability. */
	instanceId(ref: SlackThreadRef): string;
	/**
	 * Parses only canonical instance ids produced by `instanceId()`. Escape hatch: agents
	 * normally receive structured facts as creation data rather than parsing them from the id.
	 */
	parseInstanceId(id: string): SlackThreadRef;
}

/**
 * Creates a Slack channel.
 *
 * Signed request timestamps must be within five minutes of the server clock.
 * URL verification is handled internally. Other authenticated deliveries
 * are forwarded with Slack's field names and nesting, and the channel does
 * not deduplicate Events API retries.
 */
export function createSlackChannel<E extends Env = Env>(
	options: SlackChannelOptions<E>,
): SlackChannel<E> {
	validateOptions(options);
	const signingSecret = options.signingSecret;
	const routes: ChannelRouteDefinition<E>[] = [];

	if (options.events) {
		routes.push({
			method: 'POST',
			path: '/events',
			handler: createSlackEventsHandler({
				signingSecret,
				bodyLimit: options.bodyLimit,
				events: options.events,
			}),
		});
	}
	if (options.interactions) {
		routes.push({
			method: 'POST',
			path: '/interactions',
			handler: createSlackInteractionsHandler({
				signingSecret,
				bodyLimit: options.bodyLimit,
				interactions: options.interactions,
			}),
		});
	}
	if (options.commands) {
		routes.push({
			method: 'POST',
			path: '/commands',
			handler: createSlackCommandsHandler({
				signingSecret,
				bodyLimit: options.bodyLimit,
				commands: options.commands,
			}),
		});
	}
	if (routes.length === 0) {
		throw new TypeError(
			'createSlackChannel() requires an events, interactions, or commands handler.',
		);
	}

	const channel: SlackChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertThreadRef(ref);
			return `slack:v1:${encodeURIComponent(ref.teamId)}:${encodeURIComponent(ref.channelId)}:${encodeURIComponent(ref.threadTs)}`;
		},
		parseInstanceId(id) {
			try {
				const match = /^slack:v1:([^:]+):([^:]+):([^:]+)$/.exec(id);
				const teamId = match?.[1];
				const channelId = match?.[2];
				const threadTs = match?.[3];
				if (!teamId || !channelId || !threadTs) throw new InvalidSlackInstanceIdError();
				const ref = {
					teamId: decodeURIComponent(teamId),
					channelId: decodeURIComponent(channelId),
					threadTs: decodeURIComponent(threadTs),
				};
				assertThreadRef(ref);
				if (channel.instanceId(ref) !== id) throw new InvalidSlackInstanceIdError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidSlackInstanceIdError) throw error;
				throw new InvalidSlackInstanceIdError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: SlackChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createSlackChannel() requires an options object.');
	}
	assertOption(options.signingSecret, 'signingSecret');
	if (options.events !== undefined && typeof options.events !== 'function') {
		throw new TypeError('Slack events handler must be a function.');
	}
	if (options.interactions !== undefined && typeof options.interactions !== 'function') {
		throw new TypeError('Slack interactions handler must be a function.');
	}
	if (options.commands !== undefined && typeof options.commands !== 'function') {
		throw new TypeError('Slack commands handler must be a function.');
	}
}

function assertOption(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`createSlackChannel() requires a non-empty ${field}.`);
	}
}

function assertThreadRef(ref: SlackThreadRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidSlackInputError('ref');
	assertIdentifier(ref.teamId, 'teamId');
	assertIdentifier(ref.channelId, 'channelId');
	assertIdentifier(ref.threadTs, 'threadTs');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidSlackInputError(field);
	}
}
