import { defineTool, dispatch } from '@flue/runtime';
import { createTwilioChannel } from '@flue/twilio';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { TwilioClient } from '../twilio-client.ts';

export const client = new TwilioClient({
	accountSid: requiredEnv('TWILIO_ACCOUNT_SID'),
	authToken: requiredEnv('TWILIO_AUTH_TOKEN'),
});

export const channel = createTwilioChannel({
	accountSid: requiredEnv('TWILIO_ACCOUNT_SID'),
	authToken: requiredEnv('TWILIO_AUTH_TOKEN'),
	webhookUrl: requiredEnv('TWILIO_WEBHOOK_URL'),
	destination: {
		type: 'address',
		address: requiredEnv('TWILIO_PHONE_NUMBER'),
	},

	// Path: /channels/twilio/webhook
	async webhook({ payload, conversation }) {
		if (payload.OptOutType === 'STOP') return;
		const attributes: Record<string, string> = {
			messageSid: payload.MessageSid,
			from: payload.From,
		};
		const numMedia = Number(payload.NumMedia ?? '0');
		if (numMedia > 0) {
			attributes.numMedia = String(numMedia);
			for (let index = 0; index < numMedia; index += 1) {
				const contentType = payload[`MediaContentType${index}`];
				if (typeof contentType === 'string') {
					attributes[`mediaContentType${index}`] = contentType;
				}
			}
		}
		await dispatch(Assistant, {
			id: channel.instanceId(conversation),
			// Recorded once when this event creates the instance; ignored after.
			initialData:
				conversation.type === 'messaging-service'
					? {
							type: conversation.type,
							messagingServiceSid: conversation.messagingServiceSid,
							participant: conversation.participant,
						}
					: {
							type: conversation.type,
							address: conversation.address,
							participant: conversation.participant,
						},
			message: {
				kind: 'signal',
				type: 'twilio.message',
				body: payload.Body,
				attributes,
			},
		});
	},
});

export function postMessage(
	ref:
		| { type: 'address'; address: string; participant: string }
		| { type: 'messaging-service'; messagingServiceSid: string; participant: string },
) {
	return defineTool({
		name: 'post_twilio_message',
		description: 'Post a message to the Twilio conversation bound to this agent.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const result = await client.messages.create({
				to: ref.participant,
				body: data.text,
				...(ref.type === 'messaging-service'
					? { messagingServiceSid: ref.messagingServiceSid }
					: { from: ref.address }),
			});
			return { messageSid: result.sid };
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
