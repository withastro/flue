// flue-blueprint: tooling/vitest-evals@1
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk';
import { createHarness, type JsonValue, type TranscriptEvent } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
	/**
	 * Absolute URL where the agent's routes are mounted (wherever the
	 * application's app.ts mounts `createAgentRouter(...)`). Each eval case runs in a
	 * fresh conversation at `<agentUrl>/eval-<uuid>`.
	 */
	agentUrl: string;
	/** Harness display name; defaults to the agent URL's last path segment. */
	name?: string;
	token?: string;
	headers?: Record<string, string>;
}

function lastAssistantMessage(
	messages: FlueConversationMessage[],
): FlueConversationMessage | undefined {
	return messages.findLast((entry) => entry.role === 'assistant');
}

function messageText(message: FlueConversationMessage | undefined): string {
	if (!message) return '';
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('');
}

/**
 * Message metadata is agent-authored. This harness reads the convention the
 * example agent follows: `useResponseFinish(({ response }) => ({ usage:
 * response.usage, model: '<provider>/<id>' }))`. Agents that attach nothing
 * simply report no usage.
 */
interface EvalUsageMetadata {
	input: number;
	output: number;
	totalTokens: number;
	cost: { total: number };
}

function readUsageMetadata(value: unknown): EvalUsageMetadata | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost as Record<string, unknown> | undefined;
	if (
		typeof usage.input !== 'number' ||
		typeof usage.output !== 'number' ||
		typeof usage.totalTokens !== 'number' ||
		typeof cost?.total !== 'number'
	) {
		return undefined;
	}
	return {
		input: usage.input,
		output: usage.output,
		totalTokens: usage.totalTokens,
		cost: { total: cost.total },
	};
}

// Flatten the conversation into vitest-evals transcript events: a `message`
// event per turn with text, and a `tool_call`/`tool_result` pair per tool part.
function toTranscriptEvents(messages: FlueConversationMessage[]): TranscriptEvent[] {
	return messages.flatMap((message): TranscriptEvent[] => {
		const events: TranscriptEvent[] = [];
		const text = messageText(message);
		if (text) events.push({ type: 'message', role: message.role, content: text });
		for (const part of message.parts) {
			if (part.type !== 'dynamic-tool') continue;
			events.push({
				type: 'tool_call',
				id: part.toolCallId,
				name: part.toolName,
				arguments: part.input as Record<string, JsonValue> | undefined,
			});
			if (part.state === 'output-error') {
				events.push({
					type: 'tool_result',
					toolCallId: part.toolCallId,
					name: part.toolName,
					error: { message: part.errorText },
				});
			} else if (part.state === 'output-available') {
				events.push({
					type: 'tool_result',
					toolCallId: part.toolCallId,
					name: part.toolName,
					content: part.output as JsonValue,
				});
			}
		}
		return events;
	});
}

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
	const agentUrl = options.agentUrl.replace(/\/+$/, '');
	const agentName = options.name ?? (agentUrl.split('/').at(-1) as string);

	return createHarness<string, string>({
		name: `flue-${agentName}-agent`,
		run: async ({ input, signal }) => {
			// A fresh conversation per case: the caller constructs the URL by
			// appending a new id to the agent's mount URL.
			const conversation = createFlueClient({
				url: `${agentUrl}/eval-${crypto.randomUUID()}`,
				token: options.token,
				headers: options.headers,
			});
			const admission = await conversation.send({
				message: { kind: 'user', body: input },
				signal,
			});
			await conversation.wait(admission, { signal });
			const history = await conversation.history({ signal });
			const reply = lastAssistantMessage(history.messages);
			const usage = readUsageMetadata(reply?.metadata?.usage);
			const model = typeof reply?.metadata?.model === 'string' ? reply.metadata.model : undefined;
			const [provider, ...modelId] = model?.split('/') ?? [];

			return {
				output: messageText(reply),
				events: toTranscriptEvents(history.messages),
				// Usage/model come from the agent's own `useResponseFinish`
				// producer — see the convention documented on readUsageMetadata.
				...((usage ?? model)
					? {
							usage: {
								...(provider && modelId.length > 0 ? { provider, model: modelId.join('/') } : {}),
								...(usage
									? {
											inputTokens: usage.input,
											outputTokens: usage.output,
											totalTokens: usage.totalTokens,
											metadata: { cost: usage.cost.total },
										}
									: {}),
							},
						}
					: {}),
			};
		},
	});
}
