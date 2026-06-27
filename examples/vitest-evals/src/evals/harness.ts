// flue-blueprint: tooling/vitest-evals@1
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk';
import { createHarness, type SimpleToolCallRecord } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
	agentName: string;
	baseUrl?: string;
	token?: string;
	headers?: Record<string, string>;
}

function collectToolCalls(messages: FlueConversationMessage[]): SimpleToolCallRecord[] {
	return messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			if (part.type !== 'dynamic-tool') return [];
			return [
				{
					id: part.toolCallId,
					name: part.toolName,
					arguments: part.input,
					...(part.state === 'output-error'
						? { error: part.errorText }
						: part.state === 'output-available'
							? { result: part.output }
							: {}),
				},
			];
		}),
	);
}

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
	const client = createFlueClient({
		baseUrl: options.baseUrl ?? process.env.FLUE_BASE_URL ?? 'http://127.0.0.1:3583',
		token: options.token,
		headers: options.headers,
	});

	return createHarness<string, string>({
		name: `flue-${options.agentName}-agent`,
		run: async ({ input, signal }) => {
			const instanceId = `eval-${crypto.randomUUID()}`;
			const invocation = await client.agents.prompt(options.agentName, instanceId, {
				message: input,
				signal,
			});
			const history = await client.agents.history(options.agentName, instanceId, { signal });
			const toolCalls = collectToolCalls(history.messages);

			return {
				output: invocation.result.text,
				toolCalls,
				usage: {
					provider: invocation.result.model.provider,
					model: invocation.result.model.id,
					inputTokens: invocation.result.usage.input,
					outputTokens: invocation.result.usage.output,
					totalTokens: invocation.result.usage.totalTokens,
					cost: invocation.result.usage.cost.total,
				},
			};
		},
	});
}
