import { http, type Agent, type AgentContext } from '@flue/runtime';
import * as v from 'valibot';

export const channels = [http()];

/**
 * Demonstrates the two layers at which `thinkingLevel` can be set:
 *   1. harness default   — `init({ thinkingLevel: 'low' })`
 *   2. per-call override — `prompt(..., { thinkingLevel: 'minimal' })`
 *
 * One deployment, multiple reasoning tiers.
 */
export async function init({ spawn }: AgentContext): Promise<Agent> {
	return spawn({
		model: 'anthropic/claude-haiku-4-5',
		// Harness default: cheap classifier-style calls.
		thinkingLevel: 'low',
	});
}

export async function onMessage(agent: Agent) {
	const harness = agent.harness();
	const session = await harness.session();

	const Answer = v.object({ answer: v.string() });

	// 1. Harness default applies.
	const fast = await session.prompt('In one word: capital of France?', { result: Answer });

	const careful = await session.prompt('Is 1009 prime? Justify briefly.', {
		thinkingLevel: 'high',
		result: Answer,
	});

	// 2. Per-call override beats the harness default.
	const minimal = await session.prompt('Echo back: hello', {
		thinkingLevel: 'minimal',
		result: Answer,
	});

	return { fast, careful, minimal };
}
