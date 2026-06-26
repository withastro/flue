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

export interface ConversationCreatedRecord extends ConversationRecordEnvelope {
	type: 'conversation_created';
	affinityKey: string;
	createdAt: string;
	parentConversationId?: string;
	taskId?: string;
	actionInvocationId?: string;
}

export interface ConversationDeletedRecord extends ConversationRecordEnvelope {
	type: 'conversation_deleted';
	reason: 'session_deleted' | 'parent_deleted';
}

export interface UserMessageRecord extends ConversationRecordEnvelope {
	type: 'user_message';
	messageId: string;
	parentId: string | null;
	content: CanonicalUserContent[];
}

export interface SignalRecord extends ConversationRecordEnvelope {
	type: 'signal';
	messageId: string;
	parentId: string | null;
	signalType: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
}

export type AssistantModelInfo = Omit<
	AssistantMessage,
	'role' | 'content' | 'stopReason' | 'errorMessage' | 'timestamp' | 'usage'
>;

export interface AssistantMessageStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_started';
	messageId: string;
	parentId: string | null;
	modelInfo: AssistantModelInfo;
}

export interface AssistantTextStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
	textSignature?: string;
}

export interface AssistantTextDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

export interface AssistantTextCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
}

export interface AssistantReasoningStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

export interface AssistantReasoningDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

export interface AssistantReasoningCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	encrypted?: string;
	summary?: string;
	redacted?: boolean;
}

export interface AssistantToolCallRecord extends ConversationRecordEnvelope {
	type: 'assistant_tool_call';
	messageId: string;
	blockId: string;
	blockIndex: number;
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

export interface AssistantMessageCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_completed';
	messageId: string;
	stopReason: AssistantMessage['stopReason'];
	usage: AssistantMessage['usage'];
	error?: string;
}

export interface ToolResultRecord extends ConversationRecordEnvelope {
	type: 'tool_result';
	messageId: string;
	parentId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: CanonicalToolResultContent[];
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

export interface ActiveLeafChangedRecord extends ConversationRecordEnvelope {
	type: 'active_leaf_changed';
	leafId: string | null;
	previousLeafId: string | null;
	reason: string;
}

export interface CanonicalChildSessionRef {
	conversationId: string;
	harness: string;
	session: string;
	type: 'task' | 'action';
	taskId?: string;
	invocationId?: string;
}

export interface ChildSessionRetainedRecord extends ConversationRecordEnvelope {
	type: 'child_session_retained';
	child: CanonicalChildSessionRef;
}

export interface ChildSessionReleasedRecord extends ConversationRecordEnvelope {
	type: 'child_session_released';
	childConversationId: string;
}

export interface DataRecord extends ConversationRecordEnvelope {
	type: 'data';
	dataType: string;
	dataId?: string;
	data: unknown;
}

export interface SubmissionSettledRecord extends ConversationRecordEnvelope {
	type: 'submission_settled';
	outcome: 'completed' | 'failed';
	result?: unknown;
	error?: unknown;
}

export type ConversationRecord =
	| ConversationCreatedRecord
	| ConversationDeletedRecord
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
	| ToolResultRecord
	| CompactionRecord
	| ActiveLeafChangedRecord
	| ChildSessionRetainedRecord
	| ChildSessionReleasedRecord
	| DataRecord
	| SubmissionSettledRecord;

export type ConversationRecordType = ConversationRecord['type'];

export function generateConversationRecordId(): string {
	return `record_${crypto.randomUUID()}`;
}

export function generateConversationEntryId(): string {
	return `entry_${crypto.randomUUID()}`;
}
