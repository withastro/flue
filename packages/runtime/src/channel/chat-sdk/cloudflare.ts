import {
	type ChatSdkStateAdapter,
	type ChatSdkStateAdapterOptions,
	ChatSdkStateAgent,
	createChatSdkState,
	defaultKeyShard,
	defaultThreadShard,
} from 'agents/chat-sdk';

export type { ChatSdkStateAdapter as FlueChatSdkStateAdapter, ChatSdkStateAdapterOptions as FlueChatSdkStateAdapterOptions };
export {
	defaultKeyShard as defaultFlueChatSdkKeyShard,
	defaultThreadShard as defaultFlueChatSdkThreadShard,
};

export class FlueChatSdkStateAgent extends ChatSdkStateAgent {}

export function createFlueChatSdkState(
	options: ChatSdkStateAdapterOptions = {},
): ChatSdkStateAdapter {
	return createChatSdkState({
		agent: FlueChatSdkStateAgent,
		...options,
	});
}
