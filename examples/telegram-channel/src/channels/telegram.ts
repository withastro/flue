import { defineTool, dispatch } from '@flue/runtime';
import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import assistant from '../agents/assistant.ts';

export const client = new Api(requiredEnv('TELEGRAM_BOT_TOKEN'));

export const channel = createTelegramChannel({
	secretToken: requiredEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN'),

	// Path: /channels/telegram/webhook
	async webhook({ update }) {
		const incoming = update.message ?? update.channel_post ?? update.business_message;
		if (incoming) {
			const conversation = conversationFromMessage(incoming);
			await dispatch(assistant, {
				id: channel.conversationKey(conversation),
				input: {
					type: 'telegram.message',
					updateId: update.update_id,
					message: incoming,
				},
			});
			return;
		}

		if (update.callback_query) {
			const query = update.callback_query;
			await client.answerCallbackQuery(query.id);
			if (!query.message) return;
			await dispatch(assistant, {
				id: channel.conversationKey(conversationFromMessage(query.message)),
				input: {
					type: 'telegram.callback_query',
					updateId: update.update_id,
					data: query.data,
					from: query.from,
				},
			});
			return;
		}
	},
});

/** Derives the canonical destination identity from a native Telegram Message. */
function conversationFromMessage(message: Message): TelegramConversationRef {
	const topic = {
		...(message.message_thread_id === undefined
			? {}
			: { messageThreadId: message.message_thread_id }),
		...(message.direct_messages_topic?.topic_id === undefined
			? {}
			: { directMessagesTopicId: message.direct_messages_topic.topic_id }),
	};
	return message.business_connection_id
		? {
				type: 'business-chat',
				businessConnectionId: message.business_connection_id,
				chatId: message.chat.id,
				...topic,
			}
		: { type: 'chat', chatId: message.chat.id, ...topic };
}

export function postMessage(ref: TelegramConversationRef) {
	return defineTool({
		name: 'post_telegram_message',
		description: 'Post a message to the Telegram conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const message = await client.sendMessage(ref.chatId, text, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId === undefined ? {} : { message_thread_id: ref.messageThreadId }),
				...(ref.directMessagesTopicId === undefined
					? {}
					: { direct_messages_topic_id: ref.directMessagesTopicId }),
			});
			return JSON.stringify({ messageId: message.message_id });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
