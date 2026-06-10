import type { ActionEvent, Message, MessageContext, Thread, WebhookOptions } from 'chat';
import { dispatch } from '../runtime/flue-app.ts';
import type { CreatedAgent, DispatchReceipt } from '../types.ts';

export type ChatSdkChannelEvent<TState extends Record<string, unknown> = Record<string, unknown>, TRawMessage = unknown> =
	| ChatSdkChannelActionEvent<TRawMessage>
	| ChatSdkChannelMessageEvent<TState, TRawMessage>;

export interface ChatSdkChannelActionEvent<TRawMessage = unknown> {
	readonly action: ActionEvent<TRawMessage>;
	readonly kind: 'action';
	readonly thread: ActionEvent<TRawMessage>['thread'];
}

export interface ChatSdkChannelMessageEvent<TState extends Record<string, unknown> = Record<string, unknown>, TRawMessage = unknown> {
	readonly context?: MessageContext;
	readonly kind: 'new_mention' | 'subscribed_message';
	readonly message: Message<TRawMessage>;
	readonly thread: Thread<TState & FlueChatSdkThreadState, TRawMessage>;
}

export interface ChatSdkFlueTarget {
	readonly id: string;
}

export interface ChatSdkChannelOptions<TState extends Record<string, unknown> = Record<string, unknown>, TRawMessage = unknown> {
	readonly action?: ChatSdkActionMatcher<TRawMessage>;
	readonly agent: CreatedAgent;
	readonly bot: ChatSdkBot<TState & FlueChatSdkThreadState, TRawMessage>;
	readonly input: (event: ChatSdkChannelEvent<TState & FlueChatSdkThreadState, TRawMessage>) => unknown;
	readonly logger?: ChatSdkChannelLogger | false;
	readonly identity?: (
		event: ChatSdkChannelEvent<TState & FlueChatSdkThreadState, TRawMessage>,
	) => ChatSdkFlueTarget | Promise<ChatSdkFlueTarget>;
	readonly startTyping?: boolean;
	readonly subscribeOnMention?: boolean;
}

export interface ChatSdkChannel<TState extends Record<string, unknown> = Record<string, unknown>, TRawMessage = unknown> {
	readonly bot: ChatSdkBot<TState & FlueChatSdkThreadState, TRawMessage>;
	route(adapter: string): ChatSdkWebhookHandler;
}

export type ChatSdkWebhookHandler = (
	request: Request,
	options?: WebhookOptions,
) => Promise<Response>;

export type ChatSdkActionMatcher<TRawMessage = unknown> =
	| string
	| Array<string>
	| ((event: ActionEvent<TRawMessage>) => boolean | Promise<boolean>);

export interface ChatSdkChannelLogger {
	debug?(message?: unknown, ...optionalParams: Array<unknown>): void;
	error?(message?: unknown, ...optionalParams: Array<unknown>): void;
	info?(message?: unknown, ...optionalParams: Array<unknown>): void;
	warn?(message?: unknown, ...optionalParams: Array<unknown>): void;
}

interface FlueChatSdkThreadState extends Record<string, unknown> {
	_flue?: {
		id: string;
	};
}

interface ChatSdkBot<TState extends Record<string, unknown>, TRawMessage> {
	onAction(handler: (event: ActionEvent<TRawMessage>) => void | Promise<void>): void;
	onNewMention(
		handler: (
			thread: Thread<TState, TRawMessage>,
			message: Message<TRawMessage>,
			context?: MessageContext,
		) => void | Promise<void>,
	): void;
	onSubscribedMessage(
		handler: (
			thread: Thread<TState, TRawMessage>,
			message: Message<TRawMessage>,
			context?: MessageContext,
		) => void | Promise<void>,
	): void;
	thread(threadId: string): Thread<TState, TRawMessage>;
	webhooks: Record<string, ChatSdkWebhookHandler>;
}

export function createChatSdkChannel<TState extends Record<string, unknown> = Record<string, unknown>, TRawMessage = unknown>(
	options: ChatSdkChannelOptions<TState, TRawMessage>,
): ChatSdkChannel<TState, TRawMessage> {
	const logger = options.logger === false ? undefined : (options.logger ?? console);
	const subscribeOnMention = options.subscribeOnMention ?? true;
	const startTyping = options.startTyping ?? true;

	options.bot.onNewMention(async (thread, message, context) => {
		if (subscribeOnMention) {
			await thread.subscribe();
		}
		if (startTyping) {
			await safelyStartTyping(thread);
		}

		const event: ChatSdkChannelMessageEvent<TState & FlueChatSdkThreadState, TRawMessage> = {
			context,
			kind: 'new_mention',
			message,
			thread,
		};
		const target = await resolveTarget(options, event);
		await thread.setState({ _flue: target } as Partial<TState & FlueChatSdkThreadState>);
		await dispatchChannelEvent(options, event, target, logger);
	});

	options.bot.onSubscribedMessage(async (thread, message, context) => {
		if (startTyping) {
			await safelyStartTyping(thread);
		}

		const event: ChatSdkChannelMessageEvent<TState & FlueChatSdkThreadState, TRawMessage> = {
			context,
			kind: 'subscribed_message',
			message,
			thread,
		};
		const state = await thread.state;
		const target = state?._flue ?? (await resolveTarget(options, event));
		await dispatchChannelEvent(options, event, target, logger);
	});

	options.bot.onAction(async (action) => {
		if (!(await matchesAction(options.action, action))) {
			return;
		}

		const event: ChatSdkChannelActionEvent<TRawMessage> = {
			action,
			kind: 'action',
			thread: action.thread,
		};
		const target = (await readActionThreadTarget(action)) ?? (await resolveTarget(options, event));
		await dispatchChannelEvent(options, event, target, logger);
	});

	return {
		bot: options.bot,
		route(adapter) {
			const handler = options.bot.webhooks[adapter];
			if (!handler) {
				throw new Error(`[flue:channel:chat-sdk] Unknown Chat SDK adapter "${adapter}".`);
			}
			return handler;
		},
	};
}

async function dispatchChannelEvent<TState extends Record<string, unknown>, TRawMessage>(
	options: ChatSdkChannelOptions<TState, TRawMessage>,
	event: ChatSdkChannelEvent<TState & FlueChatSdkThreadState, TRawMessage>,
	target: ChatSdkFlueTarget,
	logger: ChatSdkChannelLogger | undefined,
): Promise<DispatchReceipt> {
	const input = options.input(event);
	logger?.info?.('[flue:channel:chat-sdk]', {
		agentInstanceId: target.id,
		event: event.kind,
	});
	return dispatch(options.agent, { id: target.id, input });
}

async function matchesAction<TRawMessage>(
	matcher: ChatSdkActionMatcher<TRawMessage> | undefined,
	event: ActionEvent<TRawMessage>,
): Promise<boolean> {
	if (matcher === undefined) {
		return true;
	}
	if (typeof matcher === 'string') {
		return event.actionId === matcher;
	}
	if (Array.isArray(matcher)) {
		return matcher.includes(event.actionId);
	}
	return matcher(event);
}

async function readActionThreadTarget<TRawMessage>(
	action: ActionEvent<TRawMessage>,
): Promise<ChatSdkFlueTarget | undefined> {
	if (!action.thread) {
		return undefined;
	}
	const thread = action.thread as Thread<FlueChatSdkThreadState, TRawMessage>;
	const state = await thread.state;
	return state?._flue;
}

async function resolveTarget<TState extends Record<string, unknown>, TRawMessage>(
	options: ChatSdkChannelOptions<TState, TRawMessage>,
	event: ChatSdkChannelEvent<TState & FlueChatSdkThreadState, TRawMessage>,
): Promise<ChatSdkFlueTarget> {
	const target = await (options.identity?.(event) ?? defaultTarget(event));
	assertTarget(target);
	return target;
}

function defaultTarget<TState extends Record<string, unknown>, TRawMessage>(
	event: ChatSdkChannelEvent<TState, TRawMessage>,
): ChatSdkFlueTarget {
	const threadId = event.kind === 'action' ? event.action.threadId : event.thread.id;
	return { id: threadId };
}

function assertTarget(target: ChatSdkFlueTarget): void {
	if (!target || typeof target.id !== 'string' || target.id.length === 0) {
		throw new Error('[flue:channel:chat-sdk] Chat SDK channel identity resolver returned an invalid id.');
	}
}

async function safelyStartTyping<TState extends Record<string, unknown>, TRawMessage>(
	thread: Thread<TState, TRawMessage>,
): Promise<void> {
	try {
		await thread.startTyping();
	} catch {
		return;
	}
}
