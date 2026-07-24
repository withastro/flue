import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

const appUrl = requiredEnv('GOOGLE_CHAT_APP_URL');
const jwksUrl = optionalEnv('GOOGLE_CHAT_JWKS_URL');

export const client = createGoogleChatClient({
	clientEmail: requiredEnv('GOOGLE_CHAT_CLIENT_EMAIL'),
	privateKey: requiredEnv('GOOGLE_CHAT_PRIVATE_KEY'),
});

export const channel = createGoogleChatChannel({
	interactions: {
		authentication: {
			type: 'endpoint-url',
			audience: appUrl,
			...(jwksUrl === undefined ? {} : { jwksUrl }),
		},

		// Path: /channels/google-chat/interactions
		async handler({ c, payload }) {
			switch (payload.type) {
				case 'MESSAGE':
				case 'APP_COMMAND': {
					const ref = conversationFromPayload(payload);
					if (!ref) return;
					await dispatch(Assistant, {
						id: channel.instanceId(ref),
						// Recorded once when this event creates the instance; ignored after.
						initialData: {
							space: ref.space,
							...(ref.thread === undefined ? {} : { thread: ref.thread }),
						},
						message: {
							kind: 'signal',
							type: `google-chat.${payload.type}`,
							body: payload.message?.argumentText ?? payload.message?.text ?? '',
							attributes: {
								// The message resource name is the deduplication key for retried deliveries.
								...(payload.message?.name === undefined
									? {}
									: { messageName: payload.message.name }),
								...(payload.user?.name === undefined ? {} : { userName: payload.user.name }),
								...(payload.user?.displayName === undefined
									? {}
									: { userDisplayName: payload.user.displayName }),
							},
						},
					});
					return c.body(null, 200);
				}
				default:
					return;
			}
		},
	},

	// Optional Path: /channels/google-chat/events
	// workspaceEvents: {
	//   authentication: {
	//     subscription: requiredEnv('GOOGLE_CHAT_PUBSUB_SUBSCRIPTION'),
	//     audience: requiredEnv('GOOGLE_CHAT_PUBSUB_AUDIENCE'),
	//     serviceAccountEmail: requiredEnv('GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT'),
	//   },
	//   async handler({ c, delivery }) {
	//     // Decode delivery.message.data after deduplicating delivery.message.messageId.
	//     return c.body(null, 200);
	//   },
	// },
});

export function conversationFromPayload(payload: {
	space?: {
		name?: string;
		spaceType?: GoogleChatConversationRef['spaceType'];
		type?: unknown;
	};
	message?: {
		space?: {
			name?: string;
			spaceType?: GoogleChatConversationRef['spaceType'];
			type?: unknown;
		};
		thread?: { name?: string };
	};
	thread?: { name?: string };
}): GoogleChatConversationRef | undefined {
	const space = payload.space ?? payload.message?.space;
	if (!space?.name || !/^spaces\/[^/]+$/.test(space.name)) return undefined;
	const thread = payload.message?.thread?.name ?? payload.thread?.name;
	if (thread !== undefined) {
		const match = /^(spaces\/[^/]+)\/threads\/[^/]+$/.exec(thread);
		if (!match || match[1] !== space.name) return undefined;
	}
	return {
		space: space.name,
		...(thread === undefined ? {} : { thread }),
		...(space.spaceType === undefined ? {} : { spaceType: space.spaceType }),
	};
}

export function postMessage(ref: GoogleChatConversationRef) {
	return defineTool({
		name: 'post_google_chat_message',
		description: 'Post a message to the Google Chat conversation bound to this agent.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const message = await client.postMessage(ref, data.text);
			return { message: message.name };
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function optionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}
