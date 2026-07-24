import { createMessengerChannel, type MessengerConversationRef } from '@flue/messenger';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { MessengerClient } from '../messenger-client.ts';

export const client = new MessengerClient({
	pageId: requiredEnv('MESSENGER_PAGE_ID'),
	pageAccessToken: requiredEnv('MESSENGER_PAGE_ACCESS_TOKEN'),
	graphVersion: 'v25.0',
});

export const channel = createMessengerChannel({
	appSecret: requiredEnv('MESSENGER_APP_SECRET'),
	verifyToken: requiredEnv('MESSENGER_VERIFY_TOKEN'),
	pageId: requiredEnv('MESSENGER_PAGE_ID'),

	// Paths: GET and POST /channels/messenger/webhook
	async webhook({ payload }) {
		for (const entry of payload.entry) {
			for (const event of entry.messaging ?? []) {
				// Echoes of the Page's own sends and other non-message events are
				// left to application policy. Attachment-only messages are skipped;
				// attachments alongside text surface through `attachmentTypes`.
				if (event.message === undefined || event.message.is_echo) continue;
				const conversation = channel.conversationRef(event);
				if (conversation === undefined || event.message.text === undefined) {
					continue;
				}
				const attachmentTypes = (event.message.attachments ?? []).map(
					(attachment) => attachment.type,
				);
				await dispatch(Assistant, {
					id: channel.instanceId(conversation),
					// Recorded once when this event creates the instance; ignored after.
					initialData: {
						pageId: conversation.pageId,
						participant: conversation.participant,
					},
					message: {
						kind: 'signal',
						type: 'messenger.message',
						body: event.message.text,
						attributes: {
							messageId: event.message.mid,
							...(event.message.quick_reply?.payload === undefined
								? {}
								: { quickReplyPayload: event.message.quick_reply.payload }),
							...(attachmentTypes.length === 0
								? {}
								: { attachmentTypes: attachmentTypes.join(',') }),
						},
					},
				});
			}
		}
	},
});

export function postMessage(ref: MessengerConversationRef) {
	return defineTool({
		name: 'post_messenger_message',
		description: 'Post a message to the Facebook Messenger conversation bound to this agent.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const result = await client.messages.sendText({
				to: ref.participant,
				text: data.text,
			});
			return {
				...(result.messageId === undefined ? {} : { messageId: result.messageId }),
			};
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
