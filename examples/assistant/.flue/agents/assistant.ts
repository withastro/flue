import { type FlueContext } from '@flue/sdk/client';
import { getSandbox } from '@cloudflare/sandbox';

export const triggers = { webhook: true };

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
export default async function ({ init, id, env, payload }: FlueContext) {
	const sandbox = getSandbox(env.Sandbox, id);
	const agent = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();
	const message = payload.message ?? '';
	const response = await session.prompt(message);
	return { reply: response.text };
}
