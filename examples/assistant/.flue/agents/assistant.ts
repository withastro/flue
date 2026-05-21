import { http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';
import { getSandbox } from '@cloudflare/sandbox';

export const channels = [http()];

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
export async function init({ spawn, id, env }: AgentContext): Promise<Agent> {
	const sandbox = getSandbox(env.Sandbox, id);
	return spawn({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
}

export async function onMessage(agent: Agent, message: InboundMessage) {
	const harness = agent.harness();
	const session = await harness.session();
	const { text } = await session.prompt(message.content);
	return { reply: text };
}
