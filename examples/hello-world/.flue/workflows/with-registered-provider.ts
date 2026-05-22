import { createAgent, http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

const agent = createAgent(() => ({ model: 'ollama/llama3.1:8b' }));

/**
 * Smoke-test agent for `registerProvider(...)`. Verifies that
 * `createAgent(() => ({ model: 'ollama/...' }))` resolves through the runtime registry
 * populated by the `registerProvider('ollama', ...)` call at the top of
 * `app.ts`, instead of falling through to the pi-ai catalog and erroring.
 *
 * We don't actually call the model — running this against a live Ollama
 * instance is a separate manual test. The `init()` call is enough to
 * exercise the resolution path and would throw `Unknown model "ollama/..."`
 * if the registration failed to land.
 */
export async function run({ init }: FlueContext) {
	const harness = await init(agent);
	const session = await harness.session();
	return {
		ok: true,
		// `session.model` isn't a public field, so we just confirm we got
		// past `init()` and the session was constructed.
		hasSession: typeof session === 'object',
	};
}
