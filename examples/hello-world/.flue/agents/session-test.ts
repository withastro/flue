import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

/**
 * Tests cross-invocation session persistence.
 *
 * The agent ID comes from the URL (routed by the platform).
 * Two requests to the same agent ID share the default session history.
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
export default async function ({ init, payload, id }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	const action = payload.action;

	if (action === 'set') {
		const secret = payload.secret ?? 'FLUE-42-ALPHA';
		await session.prompt(`Remember this secret code: ${secret}. I will ask you about it later.`);
		return { status: 'secret-set', id, sessionId: session.id };
	}

	if (action === 'recall') {
		const response = await session.prompt(
			'What was the secret code I told you earlier? Reply with just the code, nothing else.',
		);
		const text = response.text.trim();
		return { status: 'recalled', id, sessionId: session.id, recalled: text };
	}

	return {
		error: 'Pass payload.action: "set" or "recall". Agent ID comes from the URL path.',
	};
}
