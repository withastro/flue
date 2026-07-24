'use agent';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { defineTool, setProvider, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { bot } from '../chat.ts';

// The scripted (faux, keyless) model this offline example runs against.
// Module scope, not the agent body: the agent function is a render that may
// re-run, so one-time setup lives outside it.
const faux = fauxProvider({
	api: 'chat-sdk-example',
	provider: 'chat-sdk-example',
	models: [{ id: 'assistant' }],
});
setProvider(faux.provider);
// Faux responses are consumed one per model call, so the two-step script
// (tool call, then final text) re-queues itself after each completed
// exchange: one scripted exchange per dispatched chat message, indefinitely.
function queueExchange(): void {
	faux.appendResponses([
		(context) => {
			const input = context.messages.at(-1);
			const text =
				input?.role === 'user'
					? typeof input.content === 'string'
						? input.content
						: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
					: '';
			// Dispatched signals render to the model as an XML-ish tag whose
			// attributes carry the dispatch attributes: <signal ... threadId="...">.
			const threadId = /threadId\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? '';
			return fauxAssistantMessage(
				fauxToolCall('reply_to_chat_thread', {
					threadId,
					text: 'Reply from a Flue agent through Chat SDK.',
				}),
				{ stopReason: 'toolUse' },
			);
		},
		() => {
			queueExchange();
			return fauxAssistantMessage(fauxText('Reply sent.'));
		},
	]);
}
queueExchange();

const replyToChatThread = defineTool({
	name: 'reply_to_chat_thread',
	description: 'Post a response into the originating Chat SDK thread.',
	input: v.object({
		threadId: v.string(),
		text: v.string(),
	}),
	async run({ data }) {
		await bot.thread(data.threadId).post(data.text);
		return 'Reply sent.';
	},
});

export function Assistant() {
	useModel('chat-sdk-example/assistant');
	useTool(replyToChatThread);
	return 'When receiving a chat message, use reply_to_chat_thread to reply in the supplied thread.';
}
