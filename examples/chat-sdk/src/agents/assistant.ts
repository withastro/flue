import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { bot } from '../chat.ts';

export default defineAgent(() => {
	const faux = registerFauxProvider({
		api: 'chat-sdk-example',
		provider: 'chat-sdk-example',
		models: [{ id: 'assistant' }],
	});
	faux.setResponses([
		(context) => {
			const input = context.messages.at(-1);
			const text =
				input?.role === 'user'
					? typeof input.content === 'string'
						? input.content
						: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
					: '';
			const threadId = /"threadId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
			return fauxAssistantMessage(
				fauxToolCall('reply_to_chat_thread', {
					threadId,
					text: 'Reply from a Flue agent through Chat SDK.',
				}),
				{ stopReason: 'toolUse' },
			);
		},
		fauxAssistantMessage(fauxText('Reply sent.')),
	]);
	return {
		model: 'chat-sdk-example/assistant',
		instructions:
			'When receiving a chat message, use reply_to_chat_thread to reply in the supplied thread.',
		tools: [
			defineTool({
				name: 'reply_to_chat_thread',
				description: 'Post a response into the originating Chat SDK thread.',
				parameters: v.object({
					threadId: v.string(),
					text: v.string(),
				}),
				execute: async ({ threadId, text }) => {
					await bot.thread(threadId).post(text);
					return 'Reply sent.';
				},
			}),
		],
	};
});
