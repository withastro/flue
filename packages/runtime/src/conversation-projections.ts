import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AttachmentRef } from './conversation-records.ts';
import type {
	InProgressAssistantMessage,
	ReducedCompactionEntry,
	ReducedConversationState,
	ReducedEntry,
	ReducedMessageEntry,
} from './conversation-reducer.ts';
import {
	buildConversationContext,
	buildConversationContextEntries,
	getActiveConversationPath,
} from './conversation-reducer.ts';
import { toolResultOutput, toolResultText } from './message-rendering.ts';
import type { SubmissionState } from './submission-state.ts';
import { classifySubmissionState } from './submission-state.ts';
import type { PromptUsage } from './types.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';

/**
 * Materialized conversation part. Structurally identical to @flue/sdk's
 * `FlueConversationPart` — the public projection shape. The runtime cannot
 * import the SDK, so the shape is mirrored here and asserted by the snapshot
 * wire contract.
 */
type ConversationUiPart =
	| { type: 'text'; text: string; state: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
	// `url` mirrors the SDK shape but is never set server-side (the runtime does
	// not know the HTTP mount/baseUrl); the SDK fills it in for consumers.
	| { type: 'file'; mediaType: string; id?: string; size?: number; url?: string; filename?: string }
	| ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
			| { state: 'input-available'; input: unknown }
			| { state: 'output-available'; input: unknown; output: unknown }
			| { state: 'output-error'; input: unknown; errorText: string }
	  ));

export interface ConversationUiMessage {
	id: string;
	role: 'user' | 'assistant';
	submissionId?: string;
	parts: ConversationUiPart[];
	metadata?: {
		/** Server-authored message creation time as an ISO 8601 string. */
		timestamp?: string;
		usage?: PromptUsage;
		model?: { provider: string; id: string };
	};
}

function fileFromAttachment(attachment: AttachmentRef): ConversationUiPart {
	return {
		type: 'file',
		mediaType: attachment.mimeType,
		id: attachment.id,
		size: attachment.size,
		...(attachment.filename ? { filename: attachment.filename } : {}),
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
	return classifySubmissionState(path.slice(inputIndex + 1), options);
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
			const partIndex =
				candidate?.parts.findIndex(
					(value) => value.type === 'dynamic-tool' && value.toolCallId === toolResult.toolCallId,
				) ?? -1;
			if (!candidate || partIndex < 0) continue;
			const part = candidate.parts[partIndex] as Extract<ConversationUiPart, { type: 'dynamic-tool' }>;
			candidate.parts[partIndex] = toolResult.isError
				? { type: 'dynamic-tool', toolName: part.toolName, toolCallId: part.toolCallId, state: 'output-error', input: part.input, errorText: toolResultText(toolResult.content) }
				: { type: 'dynamic-tool', toolName: part.toolName, toolCallId: part.toolCallId, state: 'output-available', input: part.input, output: entry.toolOutput ? entry.toolOutput.value : toolResultOutput(toolResult.content) };
			break;
		}
	}
	for (const inProgress of conversation.inProgressMessages.values()) {
		const projected = projectInProgressMessage(inProgress);
		if (projected && !byId.has(projected.id)) messages.push(projected);
	}
	return { conversationId: conversation.conversationId, streamOffset, messages };
}

export function getActiveConversationPathSince(
	conversation: ReducedConversationState,
	boundaryId: string | null,
): ReducedEntry[] | undefined {
	const path = getActiveConversationPath(conversation);
	if (boundaryId === null) return path;
	const boundaryIndex = path.findIndex((entry) => entry.id === boundaryId);
	return boundaryIndex === -1 ? undefined : path.slice(boundaryIndex + 1);
}

export function getLatestCompletedAssistantEntry(
	entries: readonly ReducedEntry[],
): ReducedMessageEntry | undefined {
	return entries.findLast(
		(entry): entry is ReducedMessageEntry =>
			entry.type === 'message' &&
			entry.message.role === 'assistant' &&
			(entry.message.stopReason === 'stop' || entry.message.stopReason === 'length'),
	);
}

export function getAssistantText(assistant: AssistantMessage): string {
	return assistant.content
		.flatMap((block) => (block.type === 'text' ? [block.text] : []))
		.join('\n');
}

export function aggregateConversationUsageSince(
	conversation: ReducedConversationState,
	boundaryId: string | null,
): PromptUsage | undefined {
	const entries = getActiveConversationPathSince(conversation, boundaryId);
	if (!entries) return undefined;
	let usage = emptyUsage();
	for (const entry of entries) {
		if (entry.type === 'message' && entry.message.role === 'assistant') {
			const assistantUsage = fromProviderUsage(entry.message.usage);
			if (assistantUsage) usage = addUsage(usage, assistantUsage);
		} else if (entry.type === 'compaction' && entry.usage) {
			usage = addUsage(usage, entry.usage);
		}
	}
	return usage;
}

export function getLatestConversationCompaction(
	conversation: ReducedConversationState,
): ReducedCompactionEntry | undefined {
	return getActiveConversationPath(conversation).findLast(
		(entry): entry is ReducedCompactionEntry => entry.type === 'compaction',
	);
}

export function projectConversationModelContext(
	conversation: ReducedConversationState,
	options?: Parameters<typeof buildConversationContext>[1],
): ReturnType<typeof buildConversationContext> {
	return buildConversationContext(conversation, options);
}

export function projectConversationModelContextEntries(
	conversation: ReducedConversationState,
	options?: Parameters<typeof buildConversationContextEntries>[1],
): ReturnType<typeof buildConversationContextEntries> {
	return buildConversationContextEntries(conversation, options);
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
					if (attachment) parts.push(fileFromAttachment(attachment));
				}
			}
		}
		return {
			id: entry.id,
			role: 'user',
			...(entry.submissionId ? { submissionId: entry.submissionId } : {}),
			parts,
			metadata: { timestamp: entry.timestamp },
		};
	}
	if (message.role === 'signal') {
		return {
			id: entry.id,
			role: 'user',
			parts: [{ type: 'text', text: message.content, state: 'done' }],
			metadata: { timestamp: entry.timestamp },
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
				type: 'dynamic-tool',
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments,
				state: 'input-available',
			};
		}),
		metadata: {
			timestamp: entry.timestamp,
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
				type: 'dynamic-tool',
				toolCallId: block.toolCallId,
				toolName: block.name,
				input: block.arguments,
				state: 'input-available',
			};
		});
	// Always project the in-progress shell, even with zero parts: a client that
	// hydrates a snapshot taken between `assistant_message_started` and its first
	// delta needs the message to exist so later streamed deltas attach instead of
	// being dropped (the message-started record precedes the resume offset).
	return {
		id: message.messageId,
		role: 'assistant',
		parts,
		metadata: { timestamp: message.timestamp },
	};
}
