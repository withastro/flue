'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/telegram.ts';

const chatData = v.object({
	type: v.literal('chat'),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const businessChatData = v.object({
	type: v.literal('business-chat'),
	businessConnectionId: v.string(),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const initialDataSchema = v.variant('type', [chatData, businessChatData]);

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Telegram channel dispatch.');
	useTool(postMessage(data));
	const chatTitle = data.chatTitle ? ` ("${data.chatTitle}")` : '';
	return `Reply concisely in the bound Telegram conversation${chatTitle}.`;
}

Assistant.initialData = initialDataSchema;
