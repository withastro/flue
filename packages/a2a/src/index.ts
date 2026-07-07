import type { Context, Env, Handler } from 'hono';
import { InvalidA2AConversationKeyError, InvalidA2AInputError } from './errors.ts';
import {
	A2AProtocolError,
	createAgentCardHandler,
	createCancelTaskHandler,
	createGetTaskHandler,
	createSendMessageHandler,
	createUnsupportedHandler,
} from './handlers.ts';
import { AgentCard } from './types.ts';

export { A2AProtocolError } from './handlers.ts';
export { InvalidA2AConversationKeyError, InvalidA2AInputError } from './errors.ts';
export {
	A2A_CONTENT_TYPE,
	A2A_ERROR_REASONS,
	TERMINAL_TASK_STATES,
	// SDK value re-exports (MessageFns with fromJSON/toJSON)
	AgentCard,
	AgentCapabilities,
	AgentInterface,
	AgentProvider,
	AgentSkill,
	Artifact,
	Message,
	Part,
	Role,
	SendMessageConfiguration,
	SendMessageRequest,
	SendMessageResponse,
	Task,
	TaskState,
	roleFromJSON,
	roleToJSON,
	taskStateFromJSON,
	taskStateToJSON,
	// Type aliases (A2A-prefixed)
	type A2AAgentCapabilities,
	type A2AAgentCard,
	type A2AAgentInterface,
	type A2AAgentProvider,
	type A2AAgentSkill,
	type A2AArtifact,
	type A2AMessage,
	type A2APart,
	type A2ARole,
	type A2ARpcErrorDetail,
	type A2ARpcStatus,
	type A2ASendMessageConfiguration,
	type A2ASendMessageRequest,
	type A2ATask,
	type A2ATaskState,
	type A2ATaskStatus,
} from './types.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Canonical A2A task reference for conversation key mapping. */
export interface A2ATaskRef {
	taskId: string;
}

/** Input provided to the onMessage callback. */
export interface A2AMessageHandlerInput<E extends Env = Env> {
	/** Hono context. */
	c: Context<E>;
	/** The A2A message from the client (SDK type). */
	message: import('./types.ts').A2AMessage;
	/** Task ID if this message continues an existing task. */
	taskId?: string;
	/** Context ID for grouping related interactions. */
	contextId?: string;
	/** Request configuration (SDK type). */
	configuration?: import('./types.ts').A2ASendMessageConfiguration;
	/** Additional metadata from the request. */
	metadata?: Record<string, unknown>;
}

/**
 * Flue-specific response envelope for the onMessage callback.
 * Contains either a task or a direct message response.
 * The handler serializes SDK objects to wire format via `toJSON()`.
 */
export interface A2ASendMessageResponse {
	/** Task created or updated by the message (SDK type). */
	task?: import('./types.ts').A2ATask;
	/** Direct message response (SDK type). */
	message?: import('./types.ts').A2AMessage;
}

type A2AMessageHandlerValue =
	| undefined
	| A2ASendMessageResponse
	| Response;

/**
 * Returning nothing produces an empty `200`. A2A response objects become
 * JSON responses, and Hono or Fetch responses pass through unchanged.
 */
export type A2AMessageHandlerResult =
	| A2AMessageHandlerValue
	| Promise<A2AMessageHandlerValue>;

/** Simplified agent card configuration for common cases. */
export interface A2AAgentCardConfig {
	/** Agent name. */
	name: string;
	/** Agent description. */
	description: string;
	/** Agent version. */
	version: string;
	/** Base URL where the agent is deployed. */
	url: string;
	/** Agent skills (loose input — missing array fields default to empty). */
	skills: Array<{
		id: string;
		name: string;
		description: string;
		tags: string[];
		examples?: string[];
		inputModes?: string[];
		outputModes?: string[];
	}>;
	/** Agent provider. */
	provider?: { url: string; organization: string };
	/** Documentation URL. */
	documentationUrl?: string;
	/** Icon URL. */
	iconUrl?: string;
	/** Default input media types. Defaults to ["text/plain"]. */
	defaultInputModes?: string[];
	/** Default output media types. Defaults to ["text/plain"]. */
	defaultOutputModes?: string[];
}

/** Ingress configuration for an A2A endpoint. */
export interface A2AChannelOptions<E extends Env = Env> {
	/**
	 * Agent card configuration. Provide either a complete `A2AAgentCard` or
	 * a simplified `A2AAgentCardConfig` that will be expanded into a full card.
	 */
	agentCard: import('./types.ts').A2AAgentCard | A2AAgentCardConfig;
	/** Maximum request-body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/**
	 * Optional authentication callback. Called before every handler except
	 * the Agent Card discovery endpoint (`/.well-known/agent-card.json`).
	 *
	 * Return a `Response` to reject the request (e.g. 401/403), or
	 * `undefined`/`void` to allow it through.
	 *
	 * **WARNING:** This channel has **no built-in authentication**.
	 * Any internet-facing deployment MUST provide an `authenticate`
	 * callback to prevent unauthorized access. The A2A spec (Section 8)
	 * requires agents to declare and enforce security schemes.
	 */
	authenticate?(c: Context<E>): Promise<Response | void> | Response | void;
	/** Receives verified A2A messages. Required. */
	onMessage(input: A2AMessageHandlerInput<E>): A2AMessageHandlerResult;
	/**
	 * Retrieves a task by ID. Optional — if omitted, the `GET /tasks/:taskId`
	 * route is not registered.
	 */
	onGetTask?(input: {
		c: Context<E>;
		taskId: string;
		historyLength?: number;
	}): Promise<import('./types.ts').A2ATask | null> | import('./types.ts').A2ATask | null;
	/**
	 * Cancels a task by ID. Optional — if omitted, the
	 * `POST /tasks/{id}:cancel` route returns `UnsupportedOperationError`.
	 *
	 * The callback is responsible for validating that the task is in a
	 * cancelable state. If the task cannot be canceled, throw
	 * `A2AProtocolError` with reason `TASK_NOT_CANCELABLE` and status 400.
	 */
	onCancelTask?(input: {
		c: Context<E>;
		taskId: string;
		metadata?: Record<string, unknown>;
	}): Promise<import('./types.ts').A2ATask | null> | import('./types.ts').A2ATask | null;
}

/** Verified ingress and canonical identity helpers. */
export interface A2AChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: A2ATaskRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): A2ATaskRef;
}

/**
 * Creates an A2A channel.
 *
 * Exposes A2A protocol endpoints as Hono route handlers following
 * the Flue channel pattern. The Agent Card is served at
 * `/.well-known/agent-card.json`. Messages are received via
 * `POST /message:send` (colon-prefixed per the A2A HTTP+JSON
 * binding, Section 11.3) and forwarded to the `onMessage` callback.
 *
 * The Agent Card endpoint is the only route that does **not** go
 * through the optional `authenticate` callback — it is a public
 * discovery endpoint per the spec.
 */
export function createA2AChannel<E extends Env = Env>(
	options: A2AChannelOptions<E>,
): A2AChannel<E> {
	validateOptions(options);

	const agentCard = normalizeAgentCard(options.agentCard);
	const routes: ChannelRoute<E>[] = [];
	const auth = options.authenticate;

	// Agent Card discovery endpoint (public — no auth)
	routes.push({
		method: 'GET',
		path: '/.well-known/agent-card.json',
		handler: createAgentCardHandler<E>({ agentCard }),
	});

	// SendMessage endpoint — colon-prefixed verb per A2A spec
	routes.push({
		method: 'POST',
		path: '/message:send',
		handler: withAuth(
			auth,
			createSendMessageHandler<E>({
				bodyLimit: options.bodyLimit,
				onMessage: options.onMessage,
			}),
		),
	});

	// SendStreamingMessage stub — spec requires UnsupportedOperationError
	// instead of a plain 404 when streaming is not supported (Section 3.1.2).
	routes.push({
		method: 'POST',
		path: '/message:stream',
		handler: withAuth(auth, createUnsupportedHandler<E>('SendStreamingMessage')),
	});

	// GetTask endpoint (optional)
	if (options.onGetTask) {
		routes.push({
			method: 'GET',
			path: '/tasks/:taskId',
			handler: withAuth(auth, createGetTaskHandler<E>({ onGetTask: options.onGetTask })),
		});
	}

	// ListTasks stub — spec Section 3.1.4 lists this as a core operation.
	// Return UnsupportedOperationError until a full implementation is added.
	routes.push({
		method: 'GET',
		path: '/tasks',
		handler: withAuth(auth, createUnsupportedHandler<E>('ListTasks')),
	});

	// CancelTask endpoint — uses `/tasks/:taskIdAction` pattern because
	// the A2A spec URL is `/tasks/{id}:cancel` (Google API custom-method
	// convention). The handler parses the `:cancel` suffix.
	if (options.onCancelTask) {
		routes.push({
			method: 'POST',
			path: '/tasks/:taskIdAction',
			handler: withAuth(auth, createCancelTaskHandler<E>({ onCancelTask: options.onCancelTask })),
		});
	} else {
		routes.push({
			method: 'POST',
			path: '/tasks/:taskIdAction',
			handler: withAuth(auth, createUnsupportedHandler<E>('CancelTask')),
		});
	}

	const channel: A2AChannel<E> = {
		routes,
		conversationKey(ref) {
			assertTaskRef(ref);
			return `a2a:v1:${encodeURIComponent(ref.taskId)}`;
		},
		parseConversationKey(id) {
			try {
				const match = /^a2a:v1:([^:]+)$/.exec(id);
				const taskId = match?.[1];
				if (!taskId) throw new InvalidA2AConversationKeyError();
				const ref = { taskId: decodeURIComponent(taskId) };
				assertTaskRef(ref);
				if (channel.conversationKey(ref) !== id) throw new InvalidA2AConversationKeyError();
				return ref;
			} catch (error) {
				if (error instanceof InvalidA2AConversationKeyError) throw error;
				throw new InvalidA2AConversationKeyError();
			}
		},
	};

	return channel;
}

// ---------------------------------------------------------------------------
// Agent Card normalization
// ---------------------------------------------------------------------------

function isFullAgentCard(
	card: import('./types.ts').A2AAgentCard | A2AAgentCardConfig,
): card is import('./types.ts').A2AAgentCard {
	return 'supportedInterfaces' in card;
}

function normalizeAgentCard(
	input: import('./types.ts').A2AAgentCard | A2AAgentCardConfig,
): import('./types.ts').A2AAgentCard {
	if (isFullAgentCard(input)) return input;

	// Use AgentCard.fromJSON to properly construct an SDK-typed agent card
	// with all default values filled in.
	return AgentCard.fromJSON({
		name: input.name,
		description: input.description,
		version: input.version,
		supportedInterfaces: [
			{
				url: input.url,
				protocolBinding: 'HTTP+JSON',
				protocolVersion: '1.0',
			},
		],
		provider: input.provider,
		documentationUrl: input.documentationUrl,
		capabilities: {
			streaming: false,
			pushNotifications: false,
		},
		defaultInputModes: input.defaultInputModes ?? ['text/plain'],
		defaultOutputModes: input.defaultOutputModes ?? ['text/plain'],
		skills: input.skills,
		iconUrl: input.iconUrl,
	});
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOptions<E extends Env>(options: A2AChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createA2AChannel() requires an options object.');
	}
	if (!options.agentCard || typeof options.agentCard !== 'object') {
		throw new TypeError('createA2AChannel() requires an agentCard.');
	}
	if (typeof options.onMessage !== 'function') {
		throw new TypeError('createA2AChannel() requires an onMessage handler.');
	}

	const card = options.agentCard;
	if (typeof card.name !== 'string' || card.name.length === 0) {
		throw new TypeError('Agent card name must be a non-empty string.');
	}
	if (typeof card.description !== 'string' || card.description.length === 0) {
		throw new TypeError('Agent card description must be a non-empty string.');
	}
	if (typeof card.version !== 'string' || card.version.length === 0) {
		throw new TypeError('Agent card version must be a non-empty string.');
	}
	if (!isFullAgentCard(card)) {
		if (typeof card.url !== 'string' || card.url.length === 0) {
			throw new TypeError('Agent card url must be a non-empty string.');
		}
	}
	const skills = card.skills;
	if (!Array.isArray(skills) || skills.length === 0) {
		throw new TypeError('Agent card must have at least one skill.');
	}
}

function assertTaskRef(ref: A2ATaskRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidA2AInputError('ref');
	assertIdentifier(ref.taskId, 'taskId');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidA2AInputError(field);
	}
}

// ---------------------------------------------------------------------------
// Auth wrapper
// ---------------------------------------------------------------------------

function withAuth<E extends Env>(
	authenticate: ((c: Context<E>) => Promise<Response | void> | Response | void) | undefined,
	handler: Handler<E>,
): Handler<E> {
	if (!authenticate) return handler;
	return async (c, next) => {
		const rejection = await authenticate(c as Context<E>);
		if (rejection) return rejection;
		return handler(c, next);
	};
}
