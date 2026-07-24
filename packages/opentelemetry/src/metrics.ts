import type { Attributes, Histogram, Meter } from '@opentelemetry/api';

export interface GenAIMetrics {
	clientDuration: Histogram;
	tokenUsage: Histogram;
	agentDuration: Histogram;
	toolDuration: Histogram;
}

export function createGenAIMetrics(meter: Meter): GenAIMetrics {
	return {
		clientDuration: meter.createHistogram('gen_ai.client.operation.duration', { unit: 's' }),
		tokenUsage: meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}' }),
		agentDuration: meter.createHistogram('gen_ai.invoke_agent.duration', { unit: 's' }),
		toolDuration: meter.createHistogram('gen_ai.execute_tool.duration', { unit: 's' }),
	};
}

export function recordTokenUsage(
	metrics: GenAIMetrics,
	input: number,
	output: number,
	attributes: Attributes,
): void {
	metrics.tokenUsage.record(input, { ...attributes, 'gen_ai.token.type': 'input' });
	metrics.tokenUsage.record(output, { ...attributes, 'gen_ai.token.type': 'output' });
}
