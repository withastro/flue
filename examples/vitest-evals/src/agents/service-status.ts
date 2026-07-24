'use agent';
import { useModel, useResponseFinish, useTool } from '@flue/runtime';
import * as v from 'valibot';

const MODEL = 'anthropic/claude-haiku-4-5';

export function ServiceStatus() {
	useModel(MODEL);
	// Message metadata is agent-authored: attach the usage/model the eval
	// harness reads off the reply (see src/evals/harness.ts).
	useResponseFinish(({ response }) => ({ usage: response.usage, model: MODEL }));
	useTool({
		name: 'get_service_status',
		description: 'Look up the current operational status for a service.',
		input: v.object({ service: v.string() }),
		run: async ({ data }) => `${data.service}: operational`,
	});
	return 'Use the service status tool before answering questions about system health.';
}
