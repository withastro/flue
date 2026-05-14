import { type FlueContext } from '@flue/runtime';
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
	const harness = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();
	const message = payload.message ?? '';
	const { text } = await session.prompt(message);
	return { reply: text };
}
