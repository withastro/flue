import {
	createIntercomChannel,
	type IntercomConversationRef,
	type JsonValue,
} from '@flue/intercom';
import { defineTool, dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';
import { createIntercomClient, type IntercomRegion } from '../intercom-client.ts';

const workspaceId = requiredEnv('INTERCOM_WORKSPACE_ID');

export const client = createIntercomClient(requiredEnv('INTERCOM_ACCESS_TOKEN'), {
	region: intercomRegion(),
});

export const channel = createIntercomChannel({
	clientSecret: requiredEnv('INTERCOM_CLIENT_SECRET'),

	// Path: /channels/intercom/webhook
	async webhook({ notification }) {
		switch (notification.topic) {
			case 'conversation.user.created':
			case 'conversation.user.replied': {
				const conversationId = conversationIdFromItem(notification.data.item);
				if (!conversationId) return;
				const conversation: IntercomConversationRef = {
					workspaceId: notification.app_id,
					conversationId,
				};
				await dispatch(Assistant, {
					id: channel.instanceId(conversation),
					// Recorded once when this event creates the instance; ignored after.
					initialData: {
						workspaceId: conversation.workspaceId,
						conversationId: conversation.conversationId,
					},
					message: {
						kind: 'signal',
						type: `intercom.${notification.topic}`,
						// The conversation item is Intercom's own message payload; it has no
						// single flat text field, so it travels as the body verbatim.
						body: JSON.stringify(notification.data.item),
						attributes: {
							...(notification.id === null ? {} : { notificationId: notification.id }),
							createdAt: String(notification.created_at),
							deliveryAttempts: String(notification.delivery_attempts),
						},
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function retrieveConversation(ref: IntercomConversationRef) {
	if (ref.workspaceId !== workspaceId) {
		throw new TypeError('Expected the configured Intercom workspace.');
	}
	return defineTool({
		name: 'retrieve_intercom_conversation',
		description: 'Retrieve the current Intercom conversation bound to this agent.',
		async run() {
			return (await client.conversations.find({
				conversation_id: ref.conversationId,
				display_as: 'plaintext',
			})) as unknown as JsonValue;
		},
	});
}

function conversationIdFromItem(item: JsonValue): string | undefined {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
	const id = item.id;
	return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function intercomRegion(): IntercomRegion {
	const value = process.env.INTERCOM_REGION || 'us';
	if (value === 'us' || value === 'eu' || value === 'au') return value;
	throw new Error('INTERCOM_REGION must be us, eu, or au.');
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
