import { Type, defineTool, type ToolDefinition } from '@flue/runtime';
import type { Channel, LazyValue, MaybePromise } from './index.ts';
import { resolveLazyValue, verifyHmacSha256Signature } from './index.ts';

type SlackHandler<TEvent> = (event: TEvent) => MaybePromise<void>;

export interface SlackChannelOptions<TContext = unknown> {
	/** Slack app signing secret. Resolved lazily on inbound requests. */
	readonly signingSecret: LazyValue<string, SlackRequestContext<TContext>>;
	/** Slack bot token. Resolved lazily only when client or tool calls need it. */
	readonly botToken?: LazyValue<string, SlackRequestContext<TContext>>;
	/** Override for tests or custom runtimes. Defaults to global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Override for tests. Defaults to `Date.now`. */
	readonly now?: () => number;
}

export interface SlackRequestContext<TContext = unknown> {
	readonly request: Request;
	readonly context?: TContext;
}

export interface SlackConversationRef {
	readonly teamId: string;
	readonly channelId: string;
	readonly threadTs: string;
}

export interface SlackMessageRef extends SlackConversationRef {
	readonly messageTs: string;
}

export interface SlackEventBase {
	readonly eventId: string;
	readonly retryNum?: string;
	readonly retryReason?: string;
	readonly teamId: string;
	readonly channelId: string;
	readonly threadTs: string;
	readonly raw: unknown;
}

export interface SlackAppMentionEvent extends SlackEventBase {
	readonly type: 'app_mention';
	readonly messageTs: string;
	readonly text: string;
	readonly userId: string;
}

export interface SlackMessageEvent extends SlackEventBase {
	readonly type: 'message';
	readonly messageTs: string;
	readonly text: string;
	readonly userId: string;
}

export interface SlackBlockActionEvent extends SlackEventBase {
	readonly type: 'block_action';
	readonly actionId: string;
	readonly actionTs?: string;
	readonly actionValue?: string;
	readonly actions: ReadonlyArray<SlackActionPayloadAction>;
	readonly messageTs?: string;
	readonly responseUrl?: string;
	readonly triggerId?: string;
	readonly userId: string;
}

export interface SlackClient<TContext = unknown> {
	chatPostMessage(input: SlackChatPostMessageInput, context?: TContext): Promise<SlackApiResponse>;
	reactionsAdd(input: SlackReactionInput, context?: TContext): Promise<SlackApiResponse>;
	api<T = SlackApiResponse>(method: string, body: Record<string, unknown>, context?: TContext): Promise<T>;
}

export interface SlackTools<TContext = unknown> {
	replyInThread(ref: SlackConversationRef, context?: TContext): ToolDefinition;
	addReaction(ref: SlackMessageRef, context?: TContext): ToolDefinition;
}

export interface SlackChannel<TContext = unknown> extends Channel<TContext> {
	on(type: 'app_mention', handler: SlackHandler<SlackAppMentionEvent>): () => void;
	on(type: 'message', handler: SlackHandler<SlackMessageEvent>): () => void;
	on(type: 'block_action', handler: SlackHandler<SlackBlockActionEvent>): () => void;
	conversationKey(event: SlackConversationRef): string;
	parseConversationKey(key: string): SlackConversationRef;
	readonly client: SlackClient<TContext>;
	readonly tools: SlackTools<TContext>;
}

export interface SlackChatPostMessageInput {
	readonly channel: string;
	readonly text: string;
	readonly thread_ts?: string;
	readonly blocks?: unknown[];
}

export interface SlackReactionInput {
	readonly channel: string;
	readonly name: string;
	readonly timestamp: string;
}

export interface SlackApiResponse {
	readonly ok?: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
}

interface SlackEnvelope {
	readonly type?: string;
	readonly challenge?: string;
	readonly team_id?: string;
	readonly event_id?: string;
	readonly event?: SlackRawEvent;
}

interface SlackRawEvent {
	readonly type?: string;
	readonly subtype?: string;
	readonly bot_id?: string;
	readonly channel?: string;
	readonly team?: string;
	readonly user?: string;
	readonly text?: string;
	readonly ts?: string;
	readonly thread_ts?: string;
}

interface SlackActionPayload {
	readonly type?: string;
	readonly team?: { readonly id?: string };
	readonly user?: { readonly id?: string };
	readonly channel?: { readonly id?: string };
	readonly message?: { readonly ts?: string; readonly thread_ts?: string };
	readonly actions?: ReadonlyArray<SlackActionPayloadAction>;
	readonly response_url?: string;
	readonly trigger_id?: string;
}

interface SlackActionPayloadAction {
	readonly action_id?: string;
	readonly action_ts?: string;
	readonly value?: string;
	readonly [key: string]: unknown;
}

type SlackHandlerMap = {
	app_mention: Set<SlackHandler<SlackAppMentionEvent>>;
	message: Set<SlackHandler<SlackMessageEvent>>;
	block_action: Set<SlackHandler<SlackBlockActionEvent>>;
};

const slackTimestampToleranceSeconds = 60 * 5;

export function createSlackChannel<TContext = unknown>(options: SlackChannelOptions<TContext>): SlackChannel<TContext> {
	const handlers: SlackHandlerMap = {
		app_mention: new Set(),
		message: new Set(),
		block_action: new Set(),
	};
	const fetchImpl = options.fetch ?? fetch;
	const now = options.now ?? Date.now;

	const channel: SlackChannel = {
		async fetch(request: Request, context?: TContext) {
			if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
			const body = await request.text();
			const verification = await verifySlackRequest({
				body,
				request,
				signingSecret: await resolveLazyValue(options.signingSecret, { request, context }, 'Slack signing secret'),
				now,
			});
			if (!verification.ok) return new Response('invalid signature', { status: 401 });

			const contentType = request.headers.get('content-type') ?? '';
			if (contentType.includes('application/x-www-form-urlencoded')) {
				return handleSlackActionRequest(body, request, handlers).catch(toSlackHandlerFailure);
			}
			return handleSlackEventRequest(body, request, handlers).catch(toSlackHandlerFailure);
		},
		on(type, handler) {
			handlers[type].add(handler as never);
			return () => {
				handlers[type].delete(handler as never);
			};
		},
		conversationKey(event) {
			return `${event.teamId}:${event.channelId}:${event.threadTs}`;
		},
		parseConversationKey(key) {
			const [teamId, channelId, threadTs, extra] = key.split(':');
			if (!teamId || !channelId || !threadTs || extra !== undefined) {
				throw new Error(`[flue:channels:slack] Invalid Slack conversation key "${key}".`);
			}
			return { teamId, channelId, threadTs };
		},
		client: {
			chatPostMessage(input, context?: TContext) {
				return slackApiCall(fetchImpl, options, 'chat.postMessage', { ...input }, context);
			},
			reactionsAdd(input, context?: TContext) {
				return slackApiCall(fetchImpl, options, 'reactions.add', { ...input }, context);
			},
			api(method, body, context?: TContext) {
				return slackApiCall(fetchImpl, options, method, body, context);
			},
		},
		tools: {
			replyInThread(ref, context?: TContext) {
				return defineTool({
					name: 'reply_to_slack_thread',
					description: 'Reply in the trusted Slack thread selected by the application.',
					parameters: Type.Object({
						text: Type.String(),
					}),
					execute: async ({ text }) => {
						await channel.client.chatPostMessage({
							channel: ref.channelId,
							text,
							thread_ts: ref.threadTs,
						}, context);
						return 'Reply sent.';
					},
				});
			},
			addReaction(ref, context?: TContext) {
				return defineTool({
					name: 'add_slack_reaction',
					description: 'Add a reaction to the trusted Slack message selected by the application.',
					parameters: Type.Object({
						name: Type.String(),
					}),
					execute: async ({ name }) => {
						await channel.client.reactionsAdd({
							channel: ref.channelId,
							name,
							timestamp: ref.messageTs,
						}, context);
						return 'Reaction added.';
					},
				});
			},
		},
	};

	return channel;
}

function toSlackHandlerFailure(error: unknown): Response {
	console.error('[flue:channels:slack] Handler failed.', error);
	return new Response('handler failed', { status: 500 });
}

async function verifySlackRequest(options: {
	readonly body: string;
	readonly request: Request;
	readonly signingSecret: string;
	readonly now: () => number;
}) {
	const timestamp = options.request.headers.get('x-slack-request-timestamp');
	const signature = options.request.headers.get('x-slack-signature');
	if (!timestamp || !signature) return { ok: false };
	const timestampSeconds = Number(timestamp);
	if (!Number.isFinite(timestampSeconds)) return { ok: false };
	if (Math.abs(options.now() / 1000 - timestampSeconds) > slackTimestampToleranceSeconds) {
		return { ok: false };
	}
	return verifyHmacSha256Signature({
		secret: options.signingSecret,
		message: `v0:${timestamp}:${options.body}`,
		signature,
		prefix: 'v0=',
	});
}

async function handleSlackEventRequest(
	body: string,
	request: Request,
	handlers: SlackHandlerMap,
): Promise<Response> {
	const envelope = JSON.parse(body) as SlackEnvelope;
	if (envelope.type === 'url_verification') return Response.json({ challenge: envelope.challenge });
	if (envelope.type !== 'event_callback' || !envelope.event || !envelope.event_id) {
		return Response.json({ ok: true });
	}
	const event = normalizeSlackEvent(envelope, request);
	if (!event) return Response.json({ ok: true });
	if (event.type === 'app_mention') {
		await dispatchSlackHandlers(handlers.app_mention, event);
	} else {
		await dispatchSlackHandlers(handlers.message, event);
	}
	return Response.json({ ok: true });
}

async function handleSlackActionRequest(
	body: string,
	request: Request,
	handlers: SlackHandlerMap,
): Promise<Response> {
	const form = new URLSearchParams(body);
	const rawPayload = form.get('payload');
	if (!rawPayload) return Response.json({ ok: true });
	const payload = JSON.parse(rawPayload) as SlackActionPayload;
	if (payload.type !== 'block_actions') return Response.json({ ok: true });
	const event = normalizeSlackBlockAction(payload, request);
	if (!event) return Response.json({ ok: true });
	await dispatchSlackHandlers(handlers.block_action, event);
	return Response.json({ ok: true });
}

function normalizeSlackEvent(envelope: SlackEnvelope, request: Request): SlackAppMentionEvent | SlackMessageEvent | null {
	const event = envelope.event;
	if (!event?.type || event.bot_id || event.subtype === 'bot_message') return null;
	if (event.type !== 'app_mention' && event.type !== 'message') return null;
	if (!event.channel || !event.user || event.text === undefined || !event.ts) return null;
	const base = {
		eventId: envelope.event_id!,
		retryNum: request.headers.get('x-slack-retry-num') ?? undefined,
		retryReason: request.headers.get('x-slack-retry-reason') ?? undefined,
		teamId: envelope.team_id ?? event.team ?? 'unknown-team',
		channelId: event.channel,
		messageTs: event.ts,
		threadTs: event.thread_ts ?? event.ts,
		text: event.text,
		userId: event.user,
		raw: envelope,
	};
	return event.type === 'app_mention'
		? { ...base, type: 'app_mention' }
		: { ...base, type: 'message' };
}

function normalizeSlackBlockAction(
	payload: SlackActionPayload,
	request: Request,
): SlackBlockActionEvent | null {
	const action = payload.actions?.[0];
	if (!action?.action_id || !payload.team?.id || !payload.channel?.id || !payload.user?.id) return null;
	const messageTs = payload.message?.ts;
	const threadTs = payload.message?.thread_ts ?? messageTs ?? payload.trigger_id;
	if (!threadTs) return null;
	return {
		type: 'block_action',
		eventId: payload.trigger_id ?? `${payload.team.id}:${payload.channel.id}:${action.action_id}:${action.action_ts ?? ''}`,
		retryNum: request.headers.get('x-slack-retry-num') ?? undefined,
		retryReason: request.headers.get('x-slack-retry-reason') ?? undefined,
		teamId: payload.team.id,
		channelId: payload.channel.id,
		threadTs,
		messageTs,
		actionId: action.action_id,
		actionTs: action.action_ts,
		actionValue: action.value,
		actions: payload.actions ?? [],
		responseUrl: payload.response_url,
		triggerId: payload.trigger_id,
		userId: payload.user.id,
		raw: payload,
	};
}

async function dispatchSlackHandlers<TEvent>(handlers: Set<SlackHandler<TEvent>>, event: TEvent): Promise<void> {
	for (const handler of handlers) {
		await handler(event);
	}
}

async function slackApiCall<T, TContext>(
	fetchImpl: typeof fetch,
	options: SlackChannelOptions<TContext>,
	method: string,
	body: Record<string, unknown>,
	context: TContext | undefined,
): Promise<T> {
	const token = await resolveLazyValue(options.botToken, { request: new Request('https://slack.local/tool'), context }, 'Slack bot token');
	const response = await fetchImpl(`https://slack.com/api/${method}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify(body),
	});
	const json = await response.json().catch(() => undefined) as SlackApiResponse | undefined;
	if (!response.ok || json?.ok === false) {
		throw new Error(`[flue:channels:slack] Slack API ${method} failed: ${json?.error ?? response.statusText}`);
	}
	return json as T;
}
