import { defineTool, dispatch } from '@flue/runtime';
import { createTeamsChannel, type TeamsConversationRef } from '@flue/teams';
import assistant from '../agents/assistant.ts';
import { createTeamsClient } from '../lib/teams-client.ts';

const appId = requiredEnv('TEAMS_APP_ID');
const tenantId = requiredEnv('TEAMS_TENANT_ID');
const oauthAuthority = optionalEnv('TEAMS_OAUTH_AUTHORITY');
const openIdMetadataUrl = optionalEnv('TEAMS_OPENID_METADATA_URL');
const tokenIssuer = optionalEnv('TEAMS_TOKEN_ISSUER');

export const client = createTeamsClient({
	appId,
	tenantId,
	appPassword: requiredEnv('TEAMS_APP_PASSWORD'),
	...(oauthAuthority === undefined ? {} : { oauthAuthority }),
});

export const channel = createTeamsChannel({
	appId,
	tenantId,
	...(openIdMetadataUrl === undefined ? {} : { openIdMetadataUrl }),
	...(tokenIssuer === undefined ? {} : { tokenIssuer }),

	// Path: /channels/teams/activities
	async activities({ activity }) {
		switch (activity.type) {
			case 'message': {
				if (!activity.payload.text) return;
				await dispatch(assistant, {
					id: channel.conversationKey(activity.destination),
					input: {
						type: 'teams.message',
						activityId: activity.activityId,
						sender: activity.sender,
						text: activity.payload.text,
						mentions: activity.payload.mentions,
					},
				});
				return;
			}
			default:
				return;
		}
	},
});

export function postMessage(ref: TeamsConversationRef) {
	return defineTool({
		name: 'post_teams_message',
		description: 'Post a message to the Microsoft Teams conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const result = await client.postMessage(ref, text);
			return JSON.stringify({ activityId: result.id });
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
