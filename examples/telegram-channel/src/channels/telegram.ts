import { defineTool, dispatch } from '@flue/runtime';
import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new Api(requiredEnv('TELEGRAM_BOT_TOKEN'));

export const channel = createTelegramChannel({
	secretToken: requiredEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN'),

	// Path: /channels/telegram/webhook
	async webhook({ update }) {
		const incoming = update.message ?? update.channel_post ?? update.business_message;
		if (incoming) {
			const conversation = conversationFromMessage(incoming);
			await dispatch(Assistant, {
				id: channel.instanceId(conversation),
				// Recorded once when this event creates the instance; ignored after.
				initialData: conversationData(conversation, incoming),
				message: {
					kind: 'signal',
					type: 'telegram.message',
					body: messageBody(incoming),
					attributes: { updateId: String(update.update_id) },
				},
			});
			return;
		}

		if (update.callback_query) {
			const query = update.callback_query;
			await client.answerCallbackQuery(query.id);
			if (!query.message) return;
			const conversation = conversationFromMessage(query.message);
			await dispatch(Assistant, {
				id: channel.instanceId(conversation),
				// Recorded once when this event creates the instance; ignored after.
				initialData: conversationData(conversation, query.message),
				message: {
					kind: 'signal',
					type: 'telegram.callback_query',
					body: query.data ?? '',
					attributes: {
						updateId: String(update.update_id),
						fromId: String(query.from.id),
						...(query.from.username === undefined ? {} : { fromUsername: query.from.username }),
					},
				},
			});
			return;
		}
	},
});

/** Message text, or a short placeholder describing a media-only message. */
function messageBody(message: Message): string {
	if (message.text !== undefined) return message.text;
	if (message.caption !== undefined) return message.caption;
	if (message.photo) return '[photo message]';
	if (message.video) return '[video message]';
	if (message.voice) return '[voice message]';
	if (message.document) return '[document message]';
	if (message.sticker) return '[sticker message]';
	return '[non-text message]';
}

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

/** Instance-creation data: the destination ref plus small instance-constant context. */
function conversationData(conversation: TelegramConversationRef, message: Message) {
	return {
		type: conversation.type,
		chatId: conversation.chatId,
		...(conversation.type === 'business-chat'
			? { businessConnectionId: conversation.businessConnectionId }
			: {}),
		...(conversation.messageThreadId === undefined
			? {}
			: { messageThreadId: conversation.messageThreadId }),
		...(conversation.directMessagesTopicId === undefined
			? {}
			: { directMessagesTopicId: conversation.directMessagesTopicId }),
		...(message.chat.title === undefined ? {} : { chatTitle: message.chat.title }),
	};
}

export function postMessage(ref: TelegramConversationRef) {
	return defineTool({
		name: 'post_telegram_message',
		description: 'Post a message to the Telegram conversation bound to this agent.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const message = await client.sendMessage(ref.chatId, data.text, {
				...(ref.type === 'business-chat'
					? { business_connection_id: ref.businessConnectionId }
					: {}),
				...(ref.messageThreadId === undefined ? {} : { message_thread_id: ref.messageThreadId }),
				...(ref.directMessagesTopicId === undefined
					? {}
					: { direct_messages_topic_id: ref.directMessagesTopicId }),
			});
			return { messageId: message.message_id };
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
