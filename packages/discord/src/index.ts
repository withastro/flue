import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import { createDiscordClient } from './client.ts';
import {
	DuplicateDiscordHandlerError,
	InvalidDiscordConversationKeyError,
	InvalidDiscordInputError,
} from './errors.ts';
import { createDiscordInteractionsHandler } from './routes.ts';

export {
	DiscordApiError,
	DiscordRateLimitError,
	DiscordTimeoutError,
	DuplicateDiscordHandlerError,
	InvalidDiscordConversationKeyError,
	InvalidDiscordInputError,
} from './errors.ts';

/** Credentials, trusted application identity, and transport settings. */
export interface DiscordChannelOptions {
	/** 32-byte Discord application public key encoded as 64 hexadecimal characters. */
	publicKey: string;
	/** Expected signed Discord application id. */
	applicationId: string;
	botToken: string;
	/** Fetch implementation used by the outbound client. Defaults to `globalThis.fetch`. */
	fetch?: typeof globalThis.fetch;
	/** Outbound request timeout in milliseconds. Defaults to 10 seconds. */
	requestTimeoutMs?: number;
}

/** Supported guild-channel, guild-thread, or bot-DM destination. */
export type DiscordDestinationRef =
	| { type: 'guild'; guildId: string; channelId: string; channelKind: 'channel' | 'thread' }
	| { type: 'dm'; channelId: string };

export interface DiscordCommandData {
	name: string;
	options: readonly unknown[];
}

export interface DiscordComponentData {
	customId: string;
	componentType: number;
	values?: readonly string[];
}

export interface DiscordModalData {
	customId: string;
	components: readonly unknown[];
	fields: readonly DiscordModalField[];
}

export interface DiscordModalField {
	customId: string;
	type: number;
	value?: string;
}

export interface DiscordInteractionEnvelope<TData> {
	id: string;
	applicationId: string;
	/**
	 * Sensitive interaction capability. Keep it out of dispatch input, model
	 * context, logs, and durable session data.
	 */
	token: string;
	destination: DiscordDestinationRef;
	data: TData;
	/** Complete parsed payload. It may contain sensitive provider capabilities. */
	raw: unknown;
}

/**
 * Provider-native component input accepted by the v1 serializers.
 *
 * Message components support action rows containing non-link buttons. Modal
 * components support Label components containing text inputs.
 */
export interface DiscordComponent {
	type: number;
	customId?: string;
	label?: string;
	description?: string;
	style?: number;
	disabled?: boolean;
	value?: string;
	placeholder?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	components?: readonly DiscordComponent[];
	component?: DiscordComponent;
}

export interface DiscordMessage {
	content: string;
	components?: readonly DiscordComponent[];
	/** Allowed mention expansion. Package serializers default to no parsed mentions. */
	allowedMentions?: {
		parse?: Array<'users' | 'roles' | 'everyone'>;
		users?: string[];
		roles?: string[];
	};
}

/** Immediate response accepted from a chat-input command handler. */
export type DiscordCommandResponse =
	| { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
	| { type: 'modal'; customId: string; title: string; components: readonly DiscordComponent[] };
/** Immediate response accepted from a button handler. */
export type DiscordComponentResponse =
	| { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
	| { type: 'update_message'; message: DiscordMessage }
	| { type: 'modal'; customId: string; title: string; components: readonly DiscordComponent[] };
/** Immediate response accepted from a modal-submission handler. */
export type DiscordModalResponse =
	| { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
	| { type: 'update_message'; message: DiscordMessage };

export type DiscordInteractionHandler<TInteraction, TResponse> = (
	interaction: TInteraction,
) => TResponse | Promise<TResponse>;
export type DiscordRouteHandler = (request: Request) => Promise<Response>;

export interface DiscordInteractionRouteOptions {
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Handler deadline in milliseconds. Defaults to and may not exceed 2500. */
	handlerTimeoutMs?: number;
}

/** Fixed-origin Discord API v10 writes. Methods do not retry automatically. */
export interface DiscordClient {
	postMessage(ref: DiscordDestinationRef, message: DiscordMessage, signal?: AbortSignal): Promise<void>;
}

export interface DiscordMessageToolOptions {
	/** Mention classes enabled by trusted application code. Defaults to none. */
	allowMentions?: Array<'users' | 'roles' | 'everyone'>;
}

/** Verified interactions, outbound client/tools, and canonical identity helpers. */
export interface DiscordChannel {
	readonly routes: {
		interactions(options?: DiscordInteractionRouteOptions): DiscordRouteHandler;
	};
	readonly client: DiscordClient;
	readonly tools: {
		postMessage(ref: DiscordDestinationRef, options?: DiscordMessageToolOptions): ToolDefinition;
	};
	/** Registers the sole response-producing handler for a chat-input command name. */
	onCommand(
		name: string,
		handler: DiscordInteractionHandler<DiscordInteractionEnvelope<DiscordCommandData>, DiscordCommandResponse>,
	): () => void;
	/** Registers the sole response-producing handler for a button custom id. */
	onComponent(
		customId: string,
		handler: DiscordInteractionHandler<DiscordInteractionEnvelope<DiscordComponentData>, DiscordComponentResponse>,
	): () => void;
	/** Registers the sole response-producing handler for a modal custom id. */
	onModal(
		customId: string,
		handler: DiscordInteractionHandler<DiscordInteractionEnvelope<DiscordModalData>, DiscordModalResponse>,
	): () => void;
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: DiscordDestinationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): DiscordDestinationRef;
}

/**
 * Creates a fixed-application Discord HTTP interactions channel.
 *
 * PING is handled internally. Successful interactions wait for the registered
 * handler, and the channel does not deduplicate interaction ids.
 */
export function createDiscordChannel(options: DiscordChannelOptions): DiscordChannel {
	const publicKey = validateOptions(options);
	const applicationId = options.applicationId;
	const client = createDiscordClient(options);
	const commandHandlers = new Map<
		string,
		DiscordInteractionHandler<DiscordInteractionEnvelope<DiscordCommandData>, DiscordCommandResponse>
	>();
	const componentHandlers = new Map<
		string,
		DiscordInteractionHandler<
			DiscordInteractionEnvelope<DiscordComponentData>,
			DiscordComponentResponse
		>
	>();
	const modalHandlers = new Map<
		string,
		DiscordInteractionHandler<DiscordInteractionEnvelope<DiscordModalData>, DiscordModalResponse>
	>();

	const channel: DiscordChannel = {
		routes: {
			interactions: (routeOptions) =>
				createDiscordInteractionsHandler({
					publicKey,
					applicationId,
					bodyLimit: routeOptions?.bodyLimit,
					handlerTimeoutMs: routeOptions?.handlerTimeoutMs,
					getCommandHandler: (name) => commandHandlers.get(name),
					getComponentHandler: (customId) => componentHandlers.get(customId),
					getModalHandler: (customId) => modalHandlers.get(customId),
				}),
		},
		client,
		tools: {
			postMessage: (ref, toolOptions = {}) => {
				assertDestinationRef(ref);
				const allowMentions = validateMentionClasses(toolOptions.allowMentions);
				const boundRef = snapshotDestinationRef(ref);
				return defineTool({
					name: 'discord_post_message',
					description: 'Post a message to the bound Discord destination.',
					parameters: {
						type: 'object',
						properties: { text: { type: 'string', minLength: 1 } },
						required: ['text'],
						additionalProperties: false,
					},
					execute: async ({ text }, signal) => {
						await client.postMessage(
							boundRef,
							{ content: text, allowedMentions: { parse: allowMentions } },
							signal,
						);
						return 'Message posted.';
					},
				});
			},
		},
		onCommand(name, handler) {
			return registerOne(commandHandlers, name, handler, 'command');
		},
		onComponent(customId, handler) {
			return registerOne(componentHandlers, customId, handler, 'component');
		},
		onModal(customId, handler) {
			return registerOne(modalHandlers, customId, handler, 'modal');
		},
		conversationKey(ref) {
			assertDestinationRef(ref);
			if (ref.type === 'guild') {
				return `discord:v1:guild:${encodeURIComponent(ref.guildId)}:${ref.channelKind}:${encodeURIComponent(ref.channelId)}`;
			}
			return `discord:v1:dm:${encodeURIComponent(ref.channelId)}`;
		},
		parseConversationKey(id) {
			try {
				const guild = /^discord:v1:guild:([^:]+):(channel|thread):([^:]+)$/.exec(id);
				const guildId = guild?.[1];
				const channelKind = guild?.[2];
				const channelId = guild?.[3];
				if (guildId && (channelKind === 'channel' || channelKind === 'thread') && channelId) {
					const ref: DiscordDestinationRef = {
						type: 'guild',
						guildId: decodeURIComponent(guildId),
						channelId: decodeURIComponent(channelId),
						channelKind,
					};
					assertDestinationRef(ref);
					if (channel.conversationKey(ref) !== id) throw new InvalidDiscordConversationKeyError();
					return ref;
				}
				const dmChannelId = /^discord:v1:dm:([^:]+)$/.exec(id)?.[1];
				if (!dmChannelId) throw new InvalidDiscordConversationKeyError();
				const ref: DiscordDestinationRef = { type: 'dm', channelId: decodeURIComponent(dmChannelId) };
				assertDestinationRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidDiscordConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidDiscordConversationKeyError) throw error;
				throw new InvalidDiscordConversationKeyError();
			}
		},
	};

	return channel;
}

function registerOne<TKey, THandler>(
	handlers: Map<TKey, THandler>,
	key: TKey,
	handler: THandler,
	kind: 'command' | 'component' | 'modal',
): () => void {
	if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) {
		throw new InvalidDiscordInputError(`${kind} key`);
	}
	if (typeof handler !== 'function') {
		throw new TypeError(`Discord ${kind} handler must be a function.`);
	}
	if (handlers.has(key)) throw new DuplicateDiscordHandlerError(kind, key);
	handlers.set(key, handler);
	let active = true;
	return () => {
		if (!active) return false;
		active = false;
		if (handlers.get(key) !== handler) return false;
		return handlers.delete(key);
	};
}

function validateOptions(options: DiscordChannelOptions): Uint8Array {
	if (!options || typeof options !== 'object') throw new InvalidDiscordInputError('options');
	if (!/^[0-9a-fA-F]{64}$/.test(options.publicKey)) {
		throw new InvalidDiscordInputError('publicKey');
	}
	assertIdentifier(options.applicationId, 'applicationId');
	assertIdentifier(options.botToken, 'botToken');
	if (
		options.requestTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
	) {
		throw new InvalidDiscordInputError('requestTimeoutMs');
	}
	return decodeHex(options.publicKey);
}

function validateMentionClasses(
	value: Array<'users' | 'roles' | 'everyone'> | undefined,
): Array<'users' | 'roles' | 'everyone'> {
	if (
		value !== undefined &&
		(!Array.isArray(value) ||
			value.some((item) => item !== 'users' && item !== 'roles' && item !== 'everyone'))
	) {
		throw new InvalidDiscordInputError('allowMentions');
	}
	return [...(value ?? [])];
}

function snapshotDestinationRef(ref: DiscordDestinationRef): DiscordDestinationRef {
	return ref.type === 'guild'
		? {
				type: 'guild',
				guildId: ref.guildId,
				channelId: ref.channelId,
				channelKind: ref.channelKind,
			}
		: { type: 'dm', channelId: ref.channelId };
}

function assertDestinationRef(ref: DiscordDestinationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidDiscordInputError('ref');
	assertIdentifier(ref.channelId, 'channelId');
	if (ref.type === 'guild') {
		assertIdentifier(ref.guildId, 'guildId');
		if (ref.channelKind !== 'channel' && ref.channelKind !== 'thread') {
			throw new InvalidDiscordInputError('channelKind');
		}
		return;
	}
	if (ref.type !== 'dm') throw new InvalidDiscordInputError('destination type');
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
