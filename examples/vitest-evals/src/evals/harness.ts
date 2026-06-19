// flue-blueprint: tooling/vitest-evals@1
import { type AttachedAgentEvent, createFlueClient } from '@flue/sdk';
import { createHarness, type SimpleToolCallRecord } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
	agentName: string;
	baseUrl?: string;
	token?: string;
	headers?: Record<string, string>;
}

function collectToolCalls(events: AttachedAgentEvent[]): SimpleToolCallRecord[] {
	const argumentsById = new Map<string, unknown>();

	for (const event of events) {
		if (event.type === 'tool_start') {
			argumentsById.set(event.toolCallId, event.args);
		}
	}

	return events.flatMap((event) => {
		if (event.type !== 'tool') {
			return [];
		}

		return [
			{
				id: event.toolCallId,
				name: event.toolName,
				arguments: argumentsById.get(event.toolCallId),
				...(event.isError ? { error: event.result } : { result: event.result }),
				durationMs: event.durationMs,
			},
		];
	});
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
			const events: AttachedAgentEvent[] = [];

			for await (const event of client.agents.stream(options.agentName, instanceId, {
				offset: invocation.offset,
				signal,
			})) {
				if (event.submissionId !== invocation.submissionId) {
					continue;
				}

				events.push(event);
				if (event.type === 'idle') {
					break;
				}
			}

			const toolCalls = collectToolCalls(events);

			return {
				output: invocation.result.text,
				toolCalls,
				usage: {
					provider: invocation.result.model.provider,
					model: invocation.result.model.id,
					inputTokens: invocation.result.usage.input,
					outputTokens: invocation.result.usage.output,
					totalTokens: invocation.result.usage.totalTokens,
					toolCalls: toolCalls.length,
					metadata: {
						cacheReadTokens: invocation.result.usage.cacheRead,
						cacheWriteTokens: invocation.result.usage.cacheWrite,
						cost: invocation.result.usage.cost,
					},
				},
				metadata: {
					agent: options.agentName,
					instanceId,
					submissionId: invocation.submissionId,
				},
			};
		},
	});
}
