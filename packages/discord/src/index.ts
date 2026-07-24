import { type ChannelRouteDefinition, createChannelRouter } from '@flue/runtime';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';
import type { Context, Env, Hono } from 'hono';
import { InvalidDiscordInputError, InvalidDiscordInstanceIdError } from './errors.ts';
import { createDiscordInteractionsHandler } from './routes.ts';

export { InvalidDiscordInputError, InvalidDiscordInstanceIdError } from './errors.ts';
export type { APIInteraction, APIInteractionResponse };

export interface DiscordChannelOptions<E extends Env = Env> {
	/** Public key used to verify exact Discord request bytes. */
	publicKey: string;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives authenticated provider-native interactions other than PING. */
	interactions(input: DiscordInteractionsHandlerInput<E>): DiscordHandlerResult;
}

export type DiscordDestinationRef =
	| { type: 'guild'; guildId: string; channelId: string }
	| { type: 'dm'; channelId: string }
	| { type: 'private'; channelId: string };

/** Discord wire response or an explicit Hono/Fetch response. */
export type DiscordHandlerResult =
	APIInteractionResponse | Response | Promise<APIInteractionResponse | Response>;

export interface DiscordInteractionsHandlerInput<E extends Env = Env> {
	c: Context<E>;
	interaction: APIInteraction;
}

export interface DiscordChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRouteDefinition<E>[];
	/**
	 * Build a mountable Hono sub-app serving the channel's routes relative
	 * to the mount point: `app.route('/channels/discord', channel.route())`.
	 */
	route(): Hono<E>;
	/** Derives the agent instance id: a canonical namespaced identifier. It is not an authorization capability. */
	instanceId(ref: DiscordDestinationRef): string;
	/**
	 * Parses only instance ids produced by `instanceId()`.
	 *
	 * Escape hatch: agents normally receive structured facts as creation data
	 * rather than parsing them from the id.
	 */
	parseInstanceId(id: string): DiscordDestinationRef;
}

/**
 * Creates a Discord HTTP interactions channel.
 *
 * Signed request timestamps must be within five minutes of the server clock.
 * Signed PING requests are handled internally. Other authenticated payloads
 * preserve Discord's field names, nesting, and numeric discriminants. The
 * channel does not deduplicate interaction ids or impose a handler timeout.
 */
export function createDiscordChannel<E extends Env = Env>(
	options: DiscordChannelOptions<E>,
): DiscordChannel<E> {
	const publicKey = validateOptions(options);
	const handler = createDiscordInteractionsHandler({
		publicKey,
		bodyLimit: options.bodyLimit,
		interactions: options.interactions,
	});

	const routes: readonly ChannelRouteDefinition<E>[] = [
		{ method: 'POST', path: '/interactions', handler },
	];
	const channel: DiscordChannel<E> = {
		routes,
		route: () => createChannelRouter(routes),
		instanceId(ref) {
			assertDestinationRef(ref);
			if (ref.type === 'guild') {
				return `discord:v1:guild:${encodeURIComponent(ref.guildId)}:${encodeURIComponent(ref.channelId)}`;
			}
			return `discord:v1:${ref.type}:${encodeURIComponent(ref.channelId)}`;
		},
		parseInstanceId(id) {
			try {
				const guild = /^discord:v1:guild:([^:]+):([^:]+)$/.exec(id);
				const guildId = guild?.[1];
				const channelId = guild?.[2];
				if (guildId && channelId) {
					const ref: DiscordDestinationRef = {
						type: 'guild',
						guildId: decodeURIComponent(guildId),
						channelId: decodeURIComponent(channelId),
					};
					assertDestinationRef(ref);
					if (channel.instanceId(ref) !== id) throw new InvalidDiscordInstanceIdError();
					return ref;
				}
				const direct = /^discord:v1:(dm|private):([^:]+)$/.exec(id);
				const type = direct?.[1];
				const directChannelId = direct?.[2];
				if ((type !== 'dm' && type !== 'private') || !directChannelId) {
					throw new InvalidDiscordInstanceIdError();
				}
				const ref: DiscordDestinationRef = {
					type,
					channelId: decodeURIComponent(directChannelId),
				};
				assertDestinationRef(ref);
				if (channel.instanceId(ref) !== id) throw new InvalidDiscordInstanceIdError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidDiscordInstanceIdError) throw error;
				throw new InvalidDiscordInstanceIdError();
			}
		},
	};

	return channel;
}

function validateOptions<E extends Env>(options: DiscordChannelOptions<E>): Uint8Array {
	if (!options || typeof options !== 'object') throw new InvalidDiscordInputError('options');
	if (!/^[0-9a-fA-F]{64}$/.test(options.publicKey)) {
		throw new InvalidDiscordInputError('publicKey');
	}
	if (typeof options.interactions !== 'function') {
		throw new InvalidDiscordInputError('interactions');
	}
	return decodeHex(options.publicKey);
}

function assertDestinationRef(ref: DiscordDestinationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidDiscordInputError('ref');
	assertIdentifier(ref.channelId, 'channelId');
	if (ref.type === 'guild') {
		assertIdentifier(ref.guildId, 'guildId');
		return;
	}
	if (ref.type !== 'dm' && ref.type !== 'private') {
		throw new InvalidDiscordInputError('destination type');
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidDiscordInputError(field);
	}
}

function decodeHex(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
