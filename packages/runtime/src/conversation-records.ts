import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { PromptUsage } from './types.ts';

export interface ConversationRecordEnvelope {
	v: 1;
	id: string;
	type: string;
	conversationId: string;
	harness: string;
	session: string;
	timestamp: string;
	submissionId?: string;
	dispatchId?: string;
	operationId?: string;
	turnId?: string;
	attemptId?: string;
}

export interface AttachmentRef {
	id: string;
	mimeType: string;
	size: number;
	digest: string;
}

export type CanonicalUserContent =
	| { type: 'text'; text: string }
	| { type: 'attachment'; attachment: AttachmentRef };

export type CanonicalToolResultContent =
	| Extract<ToolResultMessage['content'][number], { type: 'text' }>
	| { type: 'attachment'; attachment: AttachmentRef };

interface ConversationCreatedRecordBase extends ConversationRecordEnvelope {
	type: 'conversation_created';
	affinityKey: string;
	createdAt: string;
}

export type ConversationCreatedRecord = ConversationCreatedRecordBase &
	(
		| {
				kind: 'root';
				parentConversationId?: never;
				taskId?: never;
				actionInvocationId?: never;
		  }
		| {
				kind: 'task';
				parentConversationId: string;
				taskId: string;
				actionInvocationId?: never;
		  }
		| {
				kind: 'action';
				parentConversationId: string;
				actionInvocationId: string;
				taskId?: never;
		  }
	);

interface UserMessageRecord extends ConversationRecordEnvelope {
	type: 'user_message';
	messageId: string;
	parentId: string | null;
	content: CanonicalUserContent[];
}

interface SignalRecord extends ConversationRecordEnvelope {
	type: 'signal';
	messageId: string;
	parentId: string | null;
	signalType: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
}

type AssistantModelInfo = Omit<
	AssistantMessage,
	'role' | 'content' | 'stopReason' | 'errorMessage' | 'timestamp' | 'usage'
>;

export interface AssistantMessageStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_started';
	messageId: string;
	parentId: string | null;
	modelInfo: AssistantModelInfo;
}

interface AssistantTextStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantTextDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantTextCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	/** Provider signature for the completed text block, captured at completion so
	 *  it round-trips back to the provider on the next turn. */
	textSignature?: string;
}

interface AssistantReasoningStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantReasoningDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantReasoningCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	encrypted?: string;
	redacted?: boolean;
}

interface AssistantToolCallRecord extends ConversationRecordEnvelope {
	type: 'assistant_tool_call';
	messageId: string;
	blockId: string;
	blockIndex: number;
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

interface AssistantMessageCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_completed';
	messageId: string;
	stopReason: AssistantMessage['stopReason'];
	usage: AssistantMessage['usage'];
	error?: string;
}

interface ToolOutcomeRecord extends ConversationRecordEnvelope {
	type: 'tool_outcome';
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/**
	 * Model-facing result content (text/attachment blocks) sent back to the LLM.
	 */
	content: CanonicalToolResultContent[];
	/**
	 * Validated structured application output, when the tool declared one. Kept
	 * distinct from `content` so the UI can render the typed value instead of the
	 * serialized model-facing text. Absent for tools without structured output.
	 */
	output?: unknown;
}

interface ToolResultsCommittedRecord extends ConversationRecordEnvelope {
	type: 'tool_results_committed';
	assistantMessageId: string;
	parentId: string;
	outcomeIds: string[];
}

export interface CompactionRecord extends ConversationRecordEnvelope {
	type: 'compaction';
	entryId: string;
	parentId: string | null;
	summary: string;
	firstKeptEntryId: string;
	sourceLeafId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: PromptUsage;
}

interface CanonicalChildSessionRefBase {
	conversationId: string;
	harness: string;
	session: string;
}

export type CanonicalChildSessionRef =
	| (CanonicalChildSessionRefBase & {
			type: 'task';
			taskId: string;
			invocationId?: never;
	  })
	| (CanonicalChildSessionRefBase & {
			type: 'action';
			invocationId: string;
			taskId?: never;
	  });

interface ChildSessionRetainedRecord extends ConversationRecordEnvelope {
	type: 'child_session_retained';
	child: CanonicalChildSessionRef;
}

export interface SubmissionSettledRecord extends ConversationRecordEnvelope {
	type: 'submission_settled';
	outcome: 'completed' | 'failed';
	result?: unknown;
	error?: unknown;
}

export type ConversationRecord =
	| ConversationCreatedRecord
	| UserMessageRecord
	| SignalRecord
	| AssistantMessageStartedRecord
	| AssistantTextStartedRecord
	| AssistantTextDeltaRecord
	| AssistantTextCompletedRecord
	| AssistantReasoningStartedRecord
	| AssistantReasoningDeltaRecord
	| AssistantReasoningCompletedRecord
	| AssistantToolCallRecord
	| AssistantMessageCompletedRecord
	| ToolOutcomeRecord
	| ToolResultsCommittedRecord
	| CompactionRecord
	| ChildSessionRetainedRecord
	| SubmissionSettledRecord;


export function generateConversationRecordId(): string {
	return `record_${crypto.randomUUID()}`;
}

export function generateConversationEntryId(): string {
	return `entry_${crypto.randomUUID()}`;
}
