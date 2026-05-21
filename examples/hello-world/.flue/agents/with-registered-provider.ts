import { http, type Agent, type AgentContext } from '@flue/runtime';

export const channels = [http()];

/**
 * Smoke-test agent for `registerProvider(...)`. Verifies that
 * `init({ model: 'ollama/...' })` resolves through the runtime registry
 * populated by the `registerProvider('ollama', ...)` call at the top of
 * `app.ts`, instead of falling through to the pi-ai catalog and erroring.
 *
 * We don't actually call the model — running this against a live Ollama
 * instance is a separate manual test. The `init()` call is enough to
 * exercise the resolution path and would throw `Unknown model "ollama/..."`
 * if the registration failed to land.
 */
export async function init({ spawn }: AgentContext): Promise<Agent> {
	return spawn({ model: 'ollama/llama3.1:8b' });
}

export async function onMessage(agent: Agent) {
	const harness = agent.harness();
	const session = await harness.session();
	return {
		ok: true,
		hasSession: typeof session === 'object',
	};
}
