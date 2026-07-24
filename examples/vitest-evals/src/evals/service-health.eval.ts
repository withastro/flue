import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

// The conversation URL base: where app.ts mounts the agent. Point
// FLUE_AGENT_URL at a deployed application to evaluate it instead.
const harness = createFlueAgentHarness({
	agentUrl: process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:3583/agents/service-status',
});

describeEval('Flue service status agent', { harness }, (it) => {
	it('checks live service status before answering', async ({ run }) => {
		const result = await run('Is the checkout service currently operational?');

		expect(result.output).toContain('operational');
		expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
