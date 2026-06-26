import { describe, expect, it } from 'vitest';
import { createFlueContext, installDevLifecycleLogger } from '../src/internal.ts';

function createContext(runId: string) {
	return createFlueContext({
		id: runId,
		runId,
		env: {},
		agentConfig: { resolveModel: () => undefined },
		createDefaultEnv: async () => {
			throw new Error('unexpected sandbox initialization');
		},
	});
}

describe('installDevLifecycleLogger()', () => {
	it('logs workflow lifecycle events and ignores other runtime events', () => {
		const messages: string[] = [];
		const logger = installDevLifecycleLogger((message) => messages.push(message));
		const ctx = createContext('run_test');

		try {
			ctx.emitEvent({
				type: 'run_start',
				runId: 'run_test',
				workflowName: 'report',
				startedAt: new Date().toISOString(),
				input: undefined,
			});
			ctx.emitEvent({ type: 'text_delta', text: 'hidden' });
			ctx.emitEvent({
				type: 'run_end',
				runId: 'run_test',
				isError: false,
				durationMs: 42,
			});

			expect(messages).toEqual([
				'[workflow] report@run_test started',
				'[workflow] report@run_test completed in 42ms',
			]);
		} finally {
			logger.dispose();
		}
	});

	it('logs agent interaction starts without prompt content', () => {
		const messages: string[] = [];
		const logger = installDevLifecycleLogger((message) => messages.push(message));

		try {
			logger.onAgentInteractionStart({
				agentName: 'support',
				instanceId: 'customer-1',
				kind: 'direct',
				submissionId: 'submission-1',
			});

			expect(messages).toEqual(['[agent] support@customer-1 started']);
		} finally {
			logger.dispose();
		}
	});
});
