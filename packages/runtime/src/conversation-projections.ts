import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AttachmentRef } from './conversation-records.ts';
import type {
	InProgressAssistantMessage,
	ReducedConversationState,
	ReducedEntry,
	ReducedMessageEntry,
} from './conversation-reducer.ts';
import { buildConversationContext, getActiveConversationPath } from './conversation-reducer.ts';
import type { SubmissionState } from './submission-state.ts';
import { classifySubmissionState } from './submission-state.ts';
import type { PromptUsage, SessionEntry } from './types.ts';

export type ConversationUiPart =
	| { type: 'text'; text: string; state: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
	| { type: 'attachment'; attachment: AttachmentRef }
	| {
			type: 'tool';
			toolCallId: string;
			toolName: string;
			input: unknown;
			state: 'input-available' | 'output-available' | 'output-error';
			output?: unknown;
			errorText?: string;
	  };

export interface ConversationUiMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: ConversationUiPart[];
	metadata?: {
		usage?: PromptUsage;
		model?: { provider: string; id: string };
	};
}

export interface ConversationUiSnapshot {
	conversationId: string;
	streamOffset: string;
	messages: ConversationUiMessage[];
}

export type CanonicalSubmissionState =
	| SubmissionState
	| { kind: 'interrupted_partial'; assistant: AssistantMessage; messageId: string };

export function classifyConversationSubmission(
	conversation: ReducedConversationState,
	inputEntryId: string,
	options: { contextWindow: number },
): CanonicalSubmissionState {
	const path = getActiveConversationPath(conversation);
	const inputIndex = path.findIndex((entry) => entry.id === inputEntryId);
	if (inputIndex === -1) return classifySubmissionState(undefined, options);
	const inProgress = [...conversation.inProgressMessages.values()].find(
		(message) => message.parentId === conversation.activeLeafId && message.blocks.size > 0,
	);
	if (inProgress) {
		return {
			kind: 'interrupted_partial',
			messageId: inProgress.messageId,
			assistant: materializeInterruptedAssistant(inProgress),
		};
	}
	return classifySubmissionState(
		path.slice(inputIndex + 1).map(toLegacyEntry),
		options,
	);
}

export function projectConversationUi(
	conversation: ReducedConversationState,
	streamOffset: string,
): ConversationUiSnapshot {
	const messages: ConversationUiMessage[] = [];
	const byId = new Map<string, ConversationUiMessage>();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== 'message') continue;
		const projected = projectCompletedMessage(entry);
		if (projected) {
			messages.push(projected);
			byId.set(projected.id, projected);
			continue;
		}
		if (entry.message.role !== 'toolResult') continue;
		const toolResult = entry.message;
		for (let index = messages.length - 1; index >= 0; index--) {
			const candidate = messages[index];
			const part = candidate?.parts.find(
				(value): value is Extract<ConversationUiPart, { type: 'tool' }> =>
					value.type === 'tool' && value.toolCallId === toolResult.toolCallId,
			);
			if (!part) continue;
			part.state = toolResult.isError ? 'output-error' : 'output-available';
			if (toolResult.isError) part.errorText = toolResultText(toolResult.content);
			else part.output = toolResultOutput(toolResult.content);
			break;
		}
	}
	for (const inProgress of conversation.inProgressMessages.values()) {
		const projected = projectInProgressMessage(inProgress);
		if (projected && !byId.has(projected.id)) messages.push(projected);
	}
	return { conversationId: conversation.conversationId, streamOffset, messages };
}

export function projectConversationModelContext(
	conversation: ReducedConversationState,
): ReturnType<typeof buildConversationContext> {
	return buildConversationContext(conversation);
}


function projectCompletedMessage(entry: ReducedMessageEntry): ConversationUiMessage | undefined {
	const message = entry.message;
	if (message.role === 'user') {
		const parts: ConversationUiPart[] = [];
		if (typeof message.content === 'string') {
			parts.push({ type: 'text', text: message.content, state: 'done' });
		} else {
			for (const block of message.content) {
				if (block.type === 'text') parts.push({ type: 'text', text: block.text, state: 'done' });
				else {
					const attachment = entry.attachmentRefs?.get(block.data);
					if (attachment) parts.push({ type: 'attachment', attachment });
				}
			}
		}
		return { id: entry.id, role: 'user', parts };
	}
	if (message.role === 'signal') {
		return {
			id: entry.id,
			role: 'user',
			parts: [{ type: 'text', text: message.content, state: 'done' }],
		};
	}
	if (message.role !== 'assistant') return undefined;
	return {
		id: entry.id,
		role: 'assistant',
		parts: message.content.map((block): ConversationUiPart => {
			if (block.type === 'text') return { type: 'text', text: block.text, state: 'done' };
			if (block.type === 'thinking') {
				return { type: 'reasoning', text: block.thinking, state: 'done' };
			}
			return {
				type: 'tool',
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments,
				state: 'input-available',
			};
		}),
		metadata: {
			usage: message.usage,
			model: { provider: message.provider, id: message.model },
		},
	};
}

function materializeInterruptedAssistant(message: InProgressAssistantMessage): AssistantMessage {
	const content = [...message.blocks.values()]
		.sort((a, b) => a.blockIndex - b.blockIndex)
		.flatMap((block): AssistantMessage['content'] => {
			if (block.type === 'text') {
				return [{ type: 'text', text: block.deltas.join(''), textSignature: block.textSignature }];
			}
			if (block.type === 'reasoning') {
				return [
					{
						type: 'thinking',
						thinking: block.deltas.join(''),
						thinkingSignature: block.encrypted,
						redacted: block.redacted,
					},
				];
			}
			return [];
		});
	return {
		...message.modelInfo,
		role: 'assistant',
		content,
		stopReason: 'aborted',
		errorMessage: 'Stream interrupted before completion.',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: new Date(message.timestamp).getTime(),
	} as AssistantMessage;
}

function projectInProgressMessage(
	message: InProgressAssistantMessage,
): ConversationUiMessage | undefined {
	const parts = [...message.blocks.values()]
		.sort((a, b) => a.blockIndex - b.blockIndex)
		.map((block): ConversationUiPart => {
			if (block.type === 'text') {
				return {
					type: 'text',
					text: block.deltas.join(''),
					state: block.completed ? 'done' : 'streaming',
				};
			}
			if (block.type === 'reasoning') {
				return {
					type: 'reasoning',
					text: block.deltas.join(''),
					state: block.completed ? 'done' : 'streaming',
				};
			}
			return {
				type: 'tool',
				toolCallId: block.toolCallId,
				toolName: block.name,
				input: block.arguments,
				state: 'input-available',
			};
		});
	if (parts.length === 0) return undefined;
	return { id: message.messageId, role: 'assistant', parts };
}

function toLegacyEntry(entry: ReducedEntry): SessionEntry {
	if (entry.type === 'message') {
		return {
			type: 'message',
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: entry.message,
		};
	}
	return {
		type: 'compaction',
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		summary: entry.summary,
		firstKeptEntryId: entry.firstKeptEntryId,
		tokensBefore: entry.tokensBefore,
		details: entry.details,
		usage: entry.usage,
	};
}

function toolResultOutput(content: Array<{ type: string; text?: string }>): unknown {
	if (content.length === 1 && content[0]?.type === 'text') return content[0].text;
	return content;
}

function toolResultText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('\n');
}
