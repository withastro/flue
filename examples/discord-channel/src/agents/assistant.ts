'use agent';
import { useAgentFinish, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/discord.ts';

const initialDataSchema = v.object({
	channelId: v.string(),
	channelName: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Discord channel dispatch.');
	useTool(postMessage(data));

	// A tool call is the ONLY way an answer reaches the thread — text the model
	// leaves in its response goes nowhere. If it would stop without posting,
	// send it back to work within the same response.
	useAgentFinish(({ response, append }) => {
		const posted = response.toolCalls.some(
			(call) => call.tool === 'post_discord_message' && !call.isError,
		);
		if (posted) return;
		append({
			kind: 'signal',
			type: 'reminder',
			body: 'You ended without calling post_discord_message — nothing reached the user. Call it now with your answer.',
		});
	});

	const channelName = data.channelName ? ` #${data.channelName}` : '';
	return `Post a concise answer to the bound Discord destination${channelName}.`;
}

Assistant.initialData = initialDataSchema;
