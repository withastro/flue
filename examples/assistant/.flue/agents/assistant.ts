import { defineAgent, type ReceiveContext } from '@flue/runtime';
import { mock } from '../channels/mock';

export const channels = [mock()];

const assistant = defineAgent({
	instructions: 'You complete task requests delivered from external channels.',
});

/**
 * Assistant — Internal assistant agent.
 *
 * Receives a task message (simulating a Google Chat webhook payload),
 * completes the task using a single prompt() call with CLI commands
 * and a task tool for delegating work to cloned repos, then returns
 * a summary to the user.
 *
 * Example:
 *   { "message": "Clone cloudflare/workers-sdk and fix the failing tests", "userId": "..." }
 *   { "message": "What version of Node.js is installed?", "userId": "..." }
 */
export async function receive({ delivery, dispatch }: ReceiveContext) {
	await dispatch({
		id: 'assistant:default',
		session: `delivery:${delivery.id}`,
		input: {
			type: 'mock.task.received',
			data: delivery.data,
		},
	});
}

export async function init({ spawn }: { spawn: (options: unknown) => unknown }) {
	return spawn({ inherit: assistant });
}
