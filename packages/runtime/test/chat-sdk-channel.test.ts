import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent-definition.ts';
import { createChatSdkChannel } from '../src/channel/chat-sdk.ts';
import type { DispatchInput, DispatchQueue } from '../src/internal.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('createChatSdkChannel()', () => {
	it('dispatches a mention and subscribed follow-up when thread state stores Flue identity', async () => {
		const assistant = createAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: recordingDispatchQueue(admitted),
			resolveDispatchAgentName: (candidate) => (candidate === assistant ? 'assistant' : undefined),
			manifest: { agents: [{ name: 'assistant', transports: {}, created: true }] },
		});
		const bot = new FakeChatSdkBot();

		createChatSdkChannel({
			agent: assistant,
			bot: bot as never,
			input: (event) => ({
				kind: event.kind,
				text: event.kind === 'action' ? event.action.value : event.message.text,
				threadId: event.kind === 'action' ? event.action.threadId : event.thread.id,
				type: 'chat.event',
			}),
			logger: false,
		});

		const thread = bot.thread('github:acme/widgets:issue:42');
		await bot.triggerMention(thread, {
			id: 'message-1',
			text: '@flue-bot schedule this',
			threadId: thread.id,
			author: { userId: 'octocat' },
		});
		await bot.triggerSubscribedMessage(thread, {
			id: 'message-2',
			text: 'approve',
			threadId: thread.id,
			author: { userId: 'octocat' },
		});

		expect(thread.subscribeCount).toBe(1);
		expect(thread.startTypingCount).toBe(2);
		expect(await thread.state).toEqual({
			_flue: {
				id: 'github:acme/widgets:issue:42',
			},
		});
		expect(admitted).toMatchObject([
			{
				agent: 'assistant',
				id: 'github:acme/widgets:issue:42',
				session: 'default',
				input: {
					kind: 'new_mention',
					text: '@flue-bot schedule this',
					threadId: 'github:acme/widgets:issue:42',
					type: 'chat.event',
				},
			},
			{
				agent: 'assistant',
				id: 'github:acme/widgets:issue:42',
				session: 'default',
				input: {
					kind: 'subscribed_message',
					text: 'approve',
					threadId: 'github:acme/widgets:issue:42',
					type: 'chat.event',
				},
			},
		]);
	});

	it('dispatches only matching actions when an action filter is configured', async () => {
		const assistant = createAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: recordingDispatchQueue(admitted),
			resolveDispatchAgentName: (candidate) => (candidate === assistant ? 'assistant' : undefined),
			manifest: { agents: [{ name: 'assistant', transports: {}, created: true }] },
		});
		const bot = new FakeChatSdkBot();

		createChatSdkChannel({
			action: ['approve'],
			agent: assistant,
			bot: bot as never,
			input: (event) => ({
				actionId: event.kind === 'action' ? event.action.actionId : undefined,
				threadId: event.kind === 'action' ? event.action.threadId : event.thread.id,
				type: 'chat.action',
			}),
			logger: false,
		});

		await bot.triggerAction({
			actionId: 'reject',
			threadId: 'github:acme/widgets:issue:42',
			user: { userId: 'octocat' },
			value: 'no',
		});
		await bot.triggerAction({
			actionId: 'approve',
			threadId: 'github:acme/widgets:issue:42',
			user: { userId: 'octocat' },
			value: 'yes',
		});

		expect(admitted).toMatchObject([
			{
				agent: 'assistant',
				id: 'github:acme/widgets:issue:42',
				session: 'default',
				input: {
					actionId: 'approve',
					threadId: 'github:acme/widgets:issue:42',
					type: 'chat.action',
				},
			},
		]);
	});

	it('dispatches actions to the Flue identity stored on the thread when present', async () => {
		const assistant = createAgent(() => ({ model: false }));
		const admitted: DispatchInput[] = [];
		configureFlueRuntime({
			target: 'node',
			dispatchQueue: recordingDispatchQueue(admitted),
			resolveDispatchAgentName: (candidate) => (candidate === assistant ? 'assistant' : undefined),
			manifest: { agents: [{ name: 'assistant', transports: {}, created: true }] },
		});
		const bot = new FakeChatSdkBot();

		createChatSdkChannel({
			agent: assistant,
			bot: bot as never,
			identity: (event) => ({
				id: event.kind === 'action' ? 'wrong-action-identity' : 'repo:acme/widgets',
			}),
			input: (event) => ({
				...(event.kind === 'action' ? { actionId: event.action.actionId } : {}),
				kind: event.kind,
				threadId: event.kind === 'action' ? event.action.threadId : event.thread.id,
				type: 'chat.event',
			}),
			logger: false,
		});

		const thread = bot.thread('github:acme/widgets:issue:42');
		await bot.triggerMention(thread, {
			id: 'message-1',
			text: '@flue-bot approve this',
			threadId: thread.id,
			author: { userId: 'octocat' },
		});
		await bot.triggerAction({
			actionId: 'approve',
			thread,
			threadId: thread.id,
			user: { userId: 'octocat' },
			value: 'yes',
		});

		expect(admitted).toMatchObject([
			{
				agent: 'assistant',
				id: 'repo:acme/widgets',
				input: {
					kind: 'new_mention',
					threadId: 'github:acme/widgets:issue:42',
					type: 'chat.event',
				},
			},
			{
				agent: 'assistant',
				id: 'repo:acme/widgets',
				input: {
					actionId: 'approve',
					kind: 'action',
					threadId: 'github:acme/widgets:issue:42',
					type: 'chat.event',
				},
			},
		]);
	});
});

function recordingDispatchQueue(admitted: DispatchInput[]): DispatchQueue {
	return {
		async enqueue(input) {
			admitted.push(input);
			return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
		},
	};
}

class FakeChatSdkBot {
	readonly threads = new Map<string, FakeThread>();
	readonly webhooks = {
		github: async () => new Response('ok'),
	};
	private actionHandler?: (event: Record<string, unknown>) => void | Promise<void>;
	private mentionHandler?: (
		thread: FakeThread,
		message: Record<string, unknown>,
	) => void | Promise<void>;
	private subscribedMessageHandler?: (
		thread: FakeThread,
		message: Record<string, unknown>,
	) => void | Promise<void>;

	onAction(handler: (event: Record<string, unknown>) => void | Promise<void>): void {
		this.actionHandler = handler;
	}

	onNewMention(
		handler: (thread: FakeThread, message: Record<string, unknown>) => void | Promise<void>,
	): void {
		this.mentionHandler = handler;
	}

	onSubscribedMessage(
		handler: (thread: FakeThread, message: Record<string, unknown>) => void | Promise<void>,
	): void {
		this.subscribedMessageHandler = handler;
	}

	thread(threadId: string): FakeThread {
		let thread = this.threads.get(threadId);
		if (!thread) {
			thread = new FakeThread(threadId);
			this.threads.set(threadId, thread);
		}
		return thread;
	}

	async triggerAction(event: Record<string, unknown>): Promise<void> {
		const thread = event.thread ?? this.thread(String(event.threadId ?? 'default'));
		await this.actionHandler?.({ raw: {}, thread, ...event });
	}

	async triggerMention(thread: FakeThread, message: Record<string, unknown>): Promise<void> {
		await this.mentionHandler?.(thread, message);
	}

	async triggerSubscribedMessage(thread: FakeThread, message: Record<string, unknown>): Promise<void> {
		await this.subscribedMessageHandler?.(thread, message);
	}
}

class FakeThread {
	readonly id: string;
	readonly channelId: string;
	startTypingCount = 0;
	subscribeCount = 0;
	private currentState: Record<string, unknown> | null = null;

	constructor(id: string) {
		this.id = id;
		this.channelId = id;
	}

	get state(): Promise<Record<string, unknown> | null> {
		return Promise.resolve(this.currentState);
	}

	async setState(newState: Record<string, unknown>): Promise<void> {
		this.currentState = { ...(this.currentState ?? {}), ...newState };
	}

	async startTyping(): Promise<void> {
		this.startTypingCount++;
	}

	async subscribe(): Promise<void> {
		this.subscribeCount++;
	}
}
