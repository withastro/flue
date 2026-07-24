import { createGitHubAdapter } from '@chat-adapter/github';
import { createMemoryState } from '@chat-adapter/state-memory';
import { type Agent, dispatch } from '@flue/runtime';
import { Chat } from 'chat';

const webhookSecret = 'chat-sdk-example-secret';
const githubApiUrl = process.env.CHAT_SDK_GITHUB_API_URL ?? 'http://localhost:3585/api/github';

export const bot = new Chat({
	userName: 'flue-bot',
	adapters: {
		github: createGitHubAdapter({
			token: 'chat-sdk-example-token',
			webhookSecret,
			userName: 'flue-bot',
			botUserId: 1,
			apiUrl: githubApiUrl,
		}),
	},
	state: createMemoryState(),
	concurrency: 'queue',
});

let handlersRegistered = false;

export function registerChatHandlers(agent: Agent): void {
	if (handlersRegistered) return;
	handlersRegistered = true;
	bot.onNewMention(async (thread, message) => {
		await dispatch(agent, {
			id: thread.id,
			message: {
				kind: 'signal',
				type: 'chat.github.mention',
				body: message.text,
				attributes: { threadId: thread.id, messageId: message.id },
			},
		});
	});
}
