import { defineAgent, type ReceiveContext } from '@flue/runtime';
import { mock } from '../channels/mock';

export const channels = [mock()];

const sessionTest = defineAgent({
	instructions: 'You are a test agent for session-oriented message delivery.',
});

/**
 * Tests cross-invocation session persistence.
 *
 * The agent instance id comes from the URL (routed by the platform).
 * Two requests to the same agent instance id share the default harness/session history.
 *
 * Payload:
 *   { "action": "set" }    — store a secret in the session
 *   { "action": "recall" } — ask the agent to recall it
 *
 * This is a multi-invocation test — it requires a running server (not flue run).
 * Example:
 *   curl -X POST localhost:3000/agents/session-test/s1 -d '{"action":"set"}'
 *   curl -X POST localhost:3000/agents/session-test/s1 -d '{"action":"recall"}'
 *
 * Note to maintainers:
 * This is a pain to test, so only run this as a test if you need the extra level of confidence,
 * if you were recently changing code that impacted sessions/persistence, or were doing a larger
 * refactor. Otherwise, this test is safe to skip and not run as part of your regular test suite.
 */
export async function receive({ delivery, dispatch }: ReceiveContext) {
	await dispatch({
		id: 'example:session-test',
		session: `delivery:${delivery.id}`,
		input: {
			type: 'mock.delivery.received',
			delivery,
		},
	});
}

export async function init({ spawn }: { spawn: (options: unknown) => unknown }) {
	return spawn({ inherit: sessionTest });
}
