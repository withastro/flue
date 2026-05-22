import { defineAgent, type AgentInitContext, type ReceiveContext } from '@flue/runtime';
import { channel as discord } from '../channels/discord';
import { channel as gchat } from '../channels/gchat';

export const channels = [discord(), gchat()];

const moderator = defineAgent({
	model: 'anthropic/claude-haiku-4-5',
	instructions: `
You manage inbound moderation cases.
Discord deliveries are evidence. Google Chat deliveries are reviewer discussion.
Do not attempt to post back to either platform; outbound actions are not part of this example.
`,
});

export async function receive({ delivery, dispatch }: ReceiveContext) {
	if (delivery.channel === 'discord' && delivery.type === 'message.created') {
		const data = delivery.data as {
			guildId?: string;
			caseId?: string;
			message?: { id?: string; authorId?: string; text?: string };
		};
		if (!data.guildId || !data.caseId || !data.message?.text) return;
		if (!looksFlagged(data.message.text)) return;

		await dispatch({
			id: `guild:${data.guildId}`,
			session: `case:${data.caseId}`,
			input: {
				type: 'discord.message.flagged',
				deliveryId: delivery.id,
				message: data.message,
			},
		});
		return;
	}

	if (delivery.channel === 'gchat' && delivery.type === 'message.created') {
		const data = delivery.data as {
			guildId?: string;
			caseId?: string;
			reviewerId?: string;
			message?: string;
		};
		if (!data.guildId || !data.caseId || !data.message) return;

		await dispatch({
			id: `guild:${data.guildId}`,
			session: `case:${data.caseId}`,
			input: {
				type: 'gchat.moderator_discussion',
				deliveryId: delivery.id,
				reviewerId: data.reviewerId,
				message: data.message,
			},
		});
	}
}

export async function init({ spawn }: AgentInitContext) {
	return spawn({ inherit: moderator });
}

function looksFlagged(text: string): boolean {
	return /\b(flag|abuse|spam)\b/i.test(text);
}
