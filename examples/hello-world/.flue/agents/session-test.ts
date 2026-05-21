import { http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';

export const channels = [http()];

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
export async function init({ spawn }: AgentContext): Promise<Agent> {
	return spawn({ model: 'anthropic/claude-sonnet-4-6' });
}

export async function onMessage(agent: Agent, message: InboundMessage) {
	const harness = agent.harness();
	const session = await harness.session();
	const action = message.metadata.action;

	if (action === 'set') {
		const secret = typeof message.metadata.secret === 'string' ? message.metadata.secret : 'FLUE-42-ALPHA';
		await session.prompt(`Remember this secret code: ${secret}. I will ask you about it later.`);
		return { status: 'secret-set', id: agent.id, sessionName: session.name };
	}

	if (action === 'recall') {
		const { text } = await session.prompt(
			'What was the secret code I told you earlier? Reply with just the code, nothing else.',
		);
		return { status: 'recalled', id: agent.id, sessionName: session.name, recalled: text.trim() };
	}

	return {
		error: 'Pass payload.action: "set" or "recall". Agent instance id comes from the URL path.',
	};
}
