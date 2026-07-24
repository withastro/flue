import { defineTool, dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new WebClient(requiredEnv('SLACK_BOT_TOKEN'));

export const channel = createSlackChannel({
	signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),

	// Path: /channels/slack/events
	async events({ payload }) {
		if (payload.type !== 'event_callback') return;

		switch (payload.event.type) {
			case 'app_mention': {
				const event = payload.event;
				const thread = {
					teamId: payload.team_id,
					channelId: event.channel,
					threadTs: event.thread_ts ?? event.ts,
				};
				await dispatch(Assistant, {
					id: channel.instanceId(thread),
					// Recorded once when this event creates the instance; ignored after.
					initialData: {
						channelId: thread.channelId,
						threadTs: thread.threadTs,
						startedBy: event.user,
						startedAt: new Date(Number(event.ts) * 1000).toISOString(),
					},
					message: {
						kind: 'signal',
						type: 'slack.app_mention',
						body: event.text,
						attributes: { eventId: payload.event_id },
					},
				});
				return;
			}
			default:
				return;
		}
	},

	// Enable this surface when the application handles Block Kit or view interactions.
	// Path: /channels/slack/interactions
	// async interactions({ payload }) {
	// 	if (payload.type === 'block_actions') {
	// 		// Handle payload.actions using Slack's native field names.
	// 	}
	// 	return;
	// },

	// Enable this surface when the application handles slash commands.
	// Path: /channels/slack/commands
	// async commands({ c, payload }) {
	// 	return c.json({ response_type: 'ephemeral', text: `Received ${payload.command}` });
	// },
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: 'Reply in the Slack thread bound to this agent.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const result = await client.chat.postMessage({
				channel: ref.channelId,
				thread_ts: ref.threadTs,
				text: data.text,
			});
			return {
				...(result.channel === undefined ? {} : { channel: result.channel }),
				...(result.ts === undefined ? {} : { ts: result.ts }),
			};
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
