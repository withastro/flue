import { createGitHubAdapter } from '@chat-adapter/github';
import { dispatch } from '@flue/runtime';
import { Agent } from 'agents';
import { ChatSdkStateAgent, createChatSdkState } from 'agents/chat-sdk';
import { Chat } from 'chat';
import assistant from './agents/assistant.ts';
import { ChatSdkExampleTestSupport } from './test-support.ts';

class FlueChatSdkStateAgent extends ChatSdkStateAgent {}

export { FlueChatSdkStateAgent };

const githubWebhookSecret = 'chat-sdk-example-secret';

type Env = {
	CHAT_SDK_GITHUB_API_URL?: string;
};

export class ChatIngressAgent extends Agent<Env> {
	private channel?: ReturnType<typeof this.createChannel>;
	private channelApiUrl?: string;
	private startupError?: Error;

	onStart(): void {
		this.channel = undefined;
		this.channelApiUrl = undefined;
		this.startupError = undefined;
	}

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const testResponse = await this.testSupport.handle(request, url);
		if (testResponse) {
			return testResponse;
		}
		if (request.method === 'POST' && url.pathname === '/deliver') {
			return this.deliver(request);
		}
		if (request.method === 'POST' && url.pathname === '/webhooks/github') {
			const channel = await this.getChannel(request);
			if (channel instanceof Error) {
				return new Response(channel.message, { status: 500 });
			}
			return channel.route(request, {
				waitUntil: (task: Promise<unknown>) => this.ctx.waitUntil(task),
			});
		}
		return new Response('Not found', { status: 404 });
	}

	private createChannel(apiUrl: string) {
		const bot = new Chat({
			adapters: {
				github: createGitHubAdapter({
					apiUrl,
					botUserId: 1,
					token: 'chat-sdk-example-token',
					userName: 'flue-bot',
					webhookSecret: githubWebhookSecret,
				}),
			},
			concurrency: 'queue',
			state: createChatSdkState({ agent: FlueChatSdkStateAgent }),
			userName: 'flue-bot',
		});

		bot.onNewMention(async (thread, message, context) => {
			await thread.subscribe();
			await safelyStartTyping(thread);
			const event: ChatSdkChannelEvent = {
				context,
				kind: 'new_mention',
				message,
				thread,
			};
			const target = { id: thread.id };
			await thread.setState({ _flue: target } as never);
			await dispatchChatSdkEvent(event, target.id);
		});

		bot.onSubscribedMessage(async (thread, message, context) => {
			await safelyStartTyping(thread);
			const event: ChatSdkChannelEvent = {
				context,
				kind: 'subscribed_message',
				message,
				thread,
			};
			const state = await thread.state as { _flue?: { id: string } } | undefined;
			await dispatchChatSdkEvent(event, state?._flue?.id ?? thread.id);
		});

		bot.onAction(async (action) => {
			const event: ChatSdkChannelEvent = {
				action,
				kind: 'action',
				thread: action.thread,
			};
			const state = action.thread
				? await (action.thread.state as Promise<{ _flue?: { id: string } } | undefined>)
				: undefined;
			await dispatchChatSdkEvent(event, state?._flue?.id ?? action.threadId);
		});

		return {
			bot,
			route(request: Request, options: { waitUntil: (task: Promise<unknown>) => void }) {
				return bot.webhooks.github(request, options);
			},
		};
	}

	private async deliver(request: Request): Promise<Response> {
		const channel = await this.getChannel(request);
		if (channel instanceof Error) {
			return new Response(channel.message, { status: 500 });
		}
		const payload = await request.json<{ text?: unknown; threadId?: unknown }>();
		if (typeof payload.threadId !== 'string' || typeof payload.text !== 'string') {
			return Response.json({ error: 'Expected threadId and text.' }, { status: 400 });
		}
		await channel.bot.thread(payload.threadId).post(payload.text);
		return Response.json({ ok: true });
	}

	private async getChannel(request: Request): Promise<NonNullable<typeof this.channel> | Error> {
		const apiUrl = await this.resolveGitHubApiUrl(request);
		if (this.channel && this.channelApiUrl === apiUrl) {
			return this.channel;
		}
		try {
			this.channel = this.createChannel(apiUrl);
			this.channelApiUrl = apiUrl;
			this.startupError = undefined;
		} catch (error) {
			this.channel = undefined;
			this.channelApiUrl = undefined;
			this.startupError = error instanceof Error ? error : new Error(String(error));
		}
		return this.channel ?? this.startupError ?? new Error('Chat SDK channel did not start.');
	}

	private async resolveGitHubApiUrl(request: Request): Promise<string> {
		return this.testSupport.githubApiUrlFor(request, this.env.CHAT_SDK_GITHUB_API_URL);
	}

	private get testSupport(): ChatSdkExampleTestSupport {
		return new ChatSdkExampleTestSupport(this.ctx.storage);
	}
}

type ChatSdkChannelEvent =
	| {
			readonly action: any;
			readonly kind: 'action';
			readonly thread?: any;
	  }
	| {
			readonly context?: unknown;
			readonly kind: 'new_mention' | 'subscribed_message';
			readonly message: any;
			readonly thread: any;
	  };

async function dispatchChatSdkEvent(event: ChatSdkChannelEvent, id: string): Promise<void> {
	console.info('[chat-sdk-example]', {
		agentInstanceId: id,
		event: event.kind,
	});
	await dispatch(assistant, {
		id,
		input: toAgentInput(event),
	});
}

function toAgentInput(event: ChatSdkChannelEvent): Record<string, unknown> {
	if (event.kind === 'action') {
		return {
			actionId: event.action.actionId,
			threadId: event.action.threadId,
			type: 'chat.action',
			userId: event.action.user.userId,
			value: event.action.value,
		};
	}
	return {
		kind: event.kind,
		messageId: event.message.id,
		text: event.message.text,
		threadId: event.thread.id,
		type: 'chat.message',
		userId: event.message.author.userId,
	};
}

async function safelyStartTyping(thread: { startTyping?: () => Promise<void> | void }): Promise<void> {
	try {
		await thread.startTyping?.();
	} catch (error) {
		console.warn('[chat-sdk-example] Failed to start typing indicator.', error);
	}
}
