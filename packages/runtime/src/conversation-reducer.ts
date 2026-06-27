import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type {
	AssistantMessageStartedRecord,
	AttachmentRef,
	CanonicalChildSessionRef,
	CanonicalToolResultContent,
	CanonicalUserContent,
	CompactionRecord,
	ConversationRecord,
} from './conversation-records.ts';
import { AttachmentNotAvailableError, ConversationRecordInvariantError } from './errors.ts';
import { createUserContextMessage, renderSignalMessage } from './message-rendering.ts';
import {
	createActionScopeName,
	createTaskSessionName,
	isPublicSessionName,
	isUuid,
} from './session-identity.ts';

interface ReducedEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
}

export interface ReducedMessageEntry extends ReducedEntryBase {
	type: 'message';
	message: AgentMessage;
	attachmentRefs?: Map<string, AttachmentRef>;
}

export interface ReducedCompactionEntry extends ReducedEntryBase {
	type: 'compaction';
	summary: string;
	firstKeptEntryId: string;
	sourceLeafId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: CompactionRecord['usage'];
}

export type ReducedEntry = ReducedMessageEntry | ReducedCompactionEntry;

interface ReducedAssistantBlockBase {
	blockId: string;
	blockIndex: number;
}

interface ReducedAssistantTextBlock extends ReducedAssistantBlockBase {
	type: 'text';
	deltas: string[];
	completed: boolean;
	textSignature?: string;
}

interface ReducedAssistantReasoningBlock extends ReducedAssistantBlockBase {
	type: 'reasoning';
	deltas: string[];
	completed: boolean;
	encrypted?: string;
	summary?: string;
	redacted?: boolean;
}

interface ReducedAssistantToolCallBlock extends ReducedAssistantBlockBase {
	type: 'tool_call';
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

type ReducedAssistantBlock =
	| ReducedAssistantTextBlock
	| ReducedAssistantReasoningBlock
	| ReducedAssistantToolCallBlock;

export interface InProgressAssistantMessage {
	messageId: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
	modelInfo: AssistantMessageStartedRecord['modelInfo'];
	blocks: Map<string, ReducedAssistantBlock>;
	blockIndexes: Set<number>;
}

interface ReducedToolOutcome {
	recordId: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: CanonicalToolResultContent[];
}

interface ReducedConversationStateBase {
	conversationId: string;
	affinityKey: string;
	createdAt: string;
	harness: string;
	session: string;
	entries: Map<string, ReducedEntry>;
	activeLeafId: string | null;
	inProgressMessages: Map<string, InProgressAssistantMessage>;
	toolOutcomes: Map<string, ReducedToolOutcome>;
	childConversations: Map<string, CanonicalChildSessionRef>;
}

export type ReducedConversationState = ReducedConversationStateBase &
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

export interface ReducedInstanceState {
	recordsThroughOffset: string;
	conversations: Map<string, ReducedConversationState>;
	conversationScopes: Map<string, string>;
	recordsById: Map<string, ConversationRecord>;
	entryOwners: Map<string, string>;
}

export interface ConversationProjectionOptions {
	resolveAttachment?: (attachment: AttachmentRef) => { data: string; mimeType: string };
}

export interface ReducedContextEntry {
	message: AgentMessage;
	sourceEntry: ReducedEntry;
}

export function createReducedInstanceState(): ReducedInstanceState {
	return {
		recordsThroughOffset: '-1',
		conversations: new Map(),
		conversationScopes: new Map(),
		recordsById: new Map(),
		entryOwners: new Map(),
	};
}

export function reduceConversationRecords(
	state: ReducedInstanceState,
	records: readonly ConversationRecord[],
	offset = state.recordsThroughOffset,
): ReducedInstanceState {
	const next = cloneReducedInstanceState(state);
	for (const record of records) applyConversationRecord(next, record);
	next.recordsThroughOffset = offset;
	return next;
}

function cloneReducedInstanceState(state: ReducedInstanceState): ReducedInstanceState {
	return {
		recordsThroughOffset: state.recordsThroughOffset,
		conversationScopes: new Map(state.conversationScopes),
		recordsById: new Map(state.recordsById),
		entryOwners: new Map(state.entryOwners),
		conversations: new Map(
			[...state.conversations].map(([id, conversation]) => [
				id,
				{
					...conversation,
					entries: new Map(
						[...conversation.entries].map(([entryId, entry]) => [
							entryId,
							entry.type === 'message'
								? {
									...entry,
									attachmentRefs: entry.attachmentRefs
										? new Map(entry.attachmentRefs)
										: undefined,
								}
								: { ...entry },
						]),
					),
					inProgressMessages: new Map(
						[...conversation.inProgressMessages].map(([messageId, message]) => [
							messageId,
							{
								...message,
								blocks: new Map(
									[...message.blocks].map(([blockId, block]) => [
										blockId,
										block.type === 'text' || block.type === 'reasoning'
											? { ...block, deltas: [...block.deltas] }
											: { ...block },
									]),
								),
								blockIndexes: new Set(message.blockIndexes),
							},
						]),
					),
					toolOutcomes: new Map(
						[...conversation.toolOutcomes].map(([toolCallId, outcome]) => [
							toolCallId,
							{ ...outcome, content: outcome.content.map((block) => ({ ...block })) },
						]),
					),
					childConversations: new Map(conversation.childConversations),
				},
			]),
		),
	};
}

export function applyConversationRecord(
	state: ReducedInstanceState,
	record: ConversationRecord,
): void {
	const accepted = state.recordsById.get(record.id);
	if (accepted) {
		if (JSON.stringify(accepted) === JSON.stringify(record)) return;
		fail(record, `Record id "${record.id}" was reused with different content.`);
	}
	if (record.v !== 1) fail(record, `Record version "${String(record.v)}" is unsupported.`);

	if (record.type === 'conversation_created') {
		validateConversationCreation(state, record);
		if (state.conversations.has(record.conversationId)) {
			fail(record, `Conversation "${record.conversationId}" is already initialized.`);
		}
		const scopeKey = conversationScopeKey(record.harness, record.session);
		const scopeOwner = state.conversationScopes.get(scopeKey);
		if (scopeOwner) {
			fail(record, `Conversation scope is already owned by "${scopeOwner}".`);
		}
		if (record.parentConversationId && !state.conversations.has(record.parentConversationId)) {
			fail(record, `Parent conversation "${record.parentConversationId}" does not exist.`);
		}
		state.conversations.set(record.conversationId, {
			...record,
			entries: new Map(),
			activeLeafId: null,
			inProgressMessages: new Map(),
			toolOutcomes: new Map(),
			childConversations: new Map(),
		});
		state.conversationScopes.set(scopeKey, record.conversationId);
		state.recordsById.set(record.id, record);
		return;
	}

	const conversation = state.conversations.get(record.conversationId);
	if (!conversation) fail(record, `Conversation "${record.conversationId}" is not initialized.`);
	if (conversation.harness !== record.harness || conversation.session !== record.session) {
		fail(record, `Conversation scope conflicts with its creation record.`);
	}
	switch (record.type) {
		case 'user_message':
			appendEntry(state, conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				message: userMessage(record.content, record.timestamp),
				attachmentRefs: attachmentRefs(record.content),
			});
			break;
		case 'signal':
			appendEntry(state, conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				message: {
					role: 'signal',
					type: record.signalType,
					tagName: record.tagName,
					content: record.content,
					attributes: record.attributes,
					timestamp: new Date(record.timestamp).getTime(),
				},
			});
			break;
		case 'assistant_message_started':
			assertParent(conversation, record, record.parentId);
			if (record.parentId !== conversation.activeLeafId) {
				fail(record, `Assistant parent is not the active leaf. Append active_leaf_changed first.`);
			}
			if (conversation.entries.has(record.messageId) || conversation.inProgressMessages.has(record.messageId)) {
				fail(record, `Assistant entry "${record.messageId}" already exists.`);
			}
			conversation.inProgressMessages.set(record.messageId, {
				messageId: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				modelInfo: record.modelInfo,
				blocks: new Map(),
				blockIndexes: new Set(),
			});
			break;
		case 'assistant_text_started': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'text',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false,
				textSignature: record.textSignature,
			});
			break;
		}
		case 'assistant_reasoning_started': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'reasoning',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false,
			});
			break;
		}
		case 'assistant_text_delta':
			appendDelta(conversation, record, 'text');
			break;
		case 'assistant_reasoning_delta':
			appendDelta(conversation, record, 'reasoning');
			break;
		case 'assistant_text_completed':
			completeBlock(conversation, record, 'text');
			break;
		case 'assistant_reasoning_completed': {
			const block = completeBlock(conversation, record, 'reasoning');
			block.encrypted = record.encrypted;
			block.summary = record.summary;
			block.redacted = record.redacted;
			break;
		}
		case 'assistant_tool_call': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'tool_call',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				toolCallId: record.toolCallId,
				name: record.name,
				arguments: record.arguments,
				thoughtSignature: record.thoughtSignature,
			});
			break;
		}
		case 'assistant_message_completed': {
			const inProgress = getInProgress(conversation, record, record.messageId);
			for (const block of inProgress.blocks.values()) {
				if ((block.type === 'text' || block.type === 'reasoning') && !block.completed) {
					fail(record, `Assistant block "${block.blockId}" is not complete.`);
				}
			}
			const content = [...inProgress.blocks.values()]
				.sort((a, b) => a.blockIndex - b.blockIndex)
				.map(materializeAssistantBlock);
			const message = {
				...inProgress.modelInfo,
				role: 'assistant',
				content,
				stopReason: record.stopReason,
				usage: record.usage,
				errorMessage: record.error,
				timestamp: new Date(inProgress.timestamp).getTime(),
			} as AssistantMessage;
			assertAssistantCompletionAppend(state, conversation, record, inProgress);
			conversation.inProgressMessages.delete(record.messageId);
			commitEntry(state, conversation, {
				type: 'message',
				id: record.messageId,
				parentId: inProgress.parentId,
				timestamp: inProgress.timestamp,
				submissionId: inProgress.submissionId,
				message,
			});
			break;
		}
		case 'tool_outcome': {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') {
				fail(record, `Tool outcome assistant "${record.assistantMessageId}" does not exist.`);
			}
			const call = assistant.message.content.find(
				(block): block is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> =>
					block.type === 'toolCall' && block.id === record.toolCallId,
			);
			if (!call || call.name !== record.toolName) {
				fail(record, `Tool outcome does not match its assistant tool request.`);
			}
			const outcomeKey = toolOutcomeKey(record.assistantMessageId, record.toolCallId);
			if (conversation.toolOutcomes.has(outcomeKey)) {
				fail(record, `Tool outcome for "${record.toolCallId}" already exists.`);
			}
			conversation.toolOutcomes.set(outcomeKey, {
				recordId: record.id,
				assistantMessageId: record.assistantMessageId,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				isError: record.isError,
				content: record.content.map((block) => ({ ...block })),
			});
			break;
		}
		case 'tool_results_committed': {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (
				assistant?.type !== 'message' ||
				assistant.message.role !== 'assistant' ||
				assistant.message.stopReason !== 'toolUse'
			) {
				fail(record, `Committed tool results require a completed tool-use assistant.`);
			}
			if (record.parentId !== record.assistantMessageId || record.parentId !== conversation.activeLeafId) {
				fail(record, `Committed tool results must extend their active assistant parent.`);
			}
			const calls = assistant.message.content.filter((block) => block.type === 'toolCall');
			if (record.outcomeIds.length !== calls.length || new Set(record.outcomeIds).size !== calls.length) {
				fail(record, `Committed tool results must reference every assistant tool call exactly once.`);
			}
			const outcomes = record.outcomeIds.map((outcomeId, index) => {
				const outcomeRecord = state.recordsById.get(outcomeId);
				const call = calls[index];
				if (
					outcomeRecord?.type !== 'tool_outcome' ||
					!call ||
					outcomeRecord.conversationId !== record.conversationId ||
					outcomeRecord.harness !== record.harness ||
					outcomeRecord.session !== record.session ||
					outcomeRecord.assistantMessageId !== record.assistantMessageId ||
					outcomeRecord.toolCallId !== call.id ||
					outcomeRecord.toolName !== call.name ||
					conversation.toolOutcomes.get(toolOutcomeKey(record.assistantMessageId, call.id))?.recordId !== outcomeId
				) {
					fail(record, `Committed tool outcome references do not match assistant tool-call order.`);
				}
				return outcomeRecord;
			});
			let parentId = record.parentId;
			for (const outcome of outcomes) {
				const entryId = toolResultEntryId(record.assistantMessageId, outcome.toolCallId);
				assertEntryAppend(state, conversation, record, entryId, parentId);
				commitEntry(state, conversation, {
					type: 'message',
					id: entryId,
					parentId,
					timestamp: outcome.timestamp,
					submissionId: record.submissionId,
					message: toolResultMessage(outcome),
					attachmentRefs: attachmentRefs(outcome.content),
				});
				parentId = entryId;
			}
			break;
		}
		case 'compaction':
			if (!conversation.entries.has(record.firstKeptEntryId)) {
				fail(record, `Compaction first-kept entry "${record.firstKeptEntryId}" does not exist.`);
			}
			if (!conversation.entries.has(record.sourceLeafId)) {
				fail(record, `Compaction source leaf "${record.sourceLeafId}" does not exist.`);
			}
			if (record.sourceLeafId !== record.parentId || record.sourceLeafId !== conversation.activeLeafId) {
				fail(record, `Compaction source leaf must be its active parent.`);
			}
			if (!pathToLeaf(conversation, record.sourceLeafId).some((entry) => entry.id === record.firstKeptEntryId)) {
				fail(record, `Compaction first-kept entry is not on the source path.`);
			}
			appendEntry(state, conversation, record, {
				type: 'compaction',
				id: record.entryId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				summary: record.summary,
				firstKeptEntryId: record.firstKeptEntryId,
				sourceLeafId: record.sourceLeafId,
				tokensBefore: record.tokensBefore,
				details: record.details,
				usage: record.usage,
			});
			break;
		case 'active_leaf_changed':
			if (conversation.activeLeafId !== record.previousLeafId) {
				fail(record, `Active leaf does not match previousLeafId.`);
			}
			if (record.leafId !== null && !conversation.entries.has(record.leafId)) {
				fail(record, `Selected leaf "${record.leafId}" does not exist.`);
			}
			conversation.activeLeafId = record.leafId;
			break;
		case 'child_session_retained': {
			validateChildReference(record);
			const child = state.conversations.get(record.child.conversationId);
			if (!child) fail(record, `Retained child conversation does not exist.`);
			const identityMatches = record.child.type === 'task'
				? child.kind === 'task' && child.taskId === record.child.taskId
				: child.kind === 'action' && child.actionInvocationId === record.child.invocationId;
			if (
				child.parentConversationId !== conversation.conversationId ||
				child.harness !== record.child.harness ||
				child.session !== record.child.session ||
				!identityMatches
			) {
				fail(record, `Retained child identity conflicts with its creation record.`);
			}
			for (const parent of state.conversations.values()) {
				if (parent !== conversation && parent.childConversations.has(record.child.conversationId)) {
					fail(record, `Child conversation is already retained by another parent.`);
				}
			}
			const existing = conversation.childConversations.get(record.child.conversationId);
			if (existing && JSON.stringify(existing) !== JSON.stringify(record.child)) {
				fail(record, `Child conversation topology conflicts with an existing retained child.`);
			}
			conversation.childConversations.set(record.child.conversationId, record.child);
			break;
		}
		case 'submission_settled':
			break;
	}
	state.recordsById.set(record.id, record);
}

function validateConversationCreation(
	state: ReducedInstanceState,
	record: Extract<ConversationRecord, { type: 'conversation_created' }>,
): void {
	const value = record as ConversationRecord & Record<string, unknown>;
	if (value.kind === 'root') {
		if (value.parentConversationId !== undefined || value.taskId !== undefined || value.actionInvocationId !== undefined) {
			fail(record, `Root conversation creation contains child identity fields.`);
		}
		return;
	}
	if (value.kind === 'task') {
		if (
			typeof value.parentConversationId !== 'string' ||
			typeof value.taskId !== 'string' ||
			value.actionInvocationId !== undefined ||
			!isUuid(value.taskId)
		) {
			fail(record, `Task conversation creation has invalid discriminated identity.`);
		}
		const parent = state.conversations.get(value.parentConversationId);
		if (!parent) return;
		if (record.harness !== parent.harness || record.session !== createTaskSessionName(parent.session, value.taskId)) {
			fail(record, `Task conversation scope does not match its derived parent identity.`);
		}
		return;
	}
	if (
		value.kind !== 'action' ||
		typeof value.parentConversationId !== 'string' ||
		typeof value.actionInvocationId !== 'string' ||
		value.taskId !== undefined ||
		!isUuid(value.actionInvocationId)
	) {
		fail(record, `Action conversation creation has invalid discriminated identity.`);
	}
	const parent = state.conversations.get(value.parentConversationId);
	if (!parent) return;
	if (
		record.harness !== `${parent.harness}:${createActionScopeName(value.actionInvocationId)}` ||
		!isPublicSessionName(record.session)
	) {
		fail(record, `Action conversation scope does not match its derived parent identity.`);
	}
}

function validateChildReference(
	record: Extract<ConversationRecord, { type: 'child_session_retained' }>,
): void {
	const child = record.child as CanonicalChildSessionRef & Record<string, unknown>;
	if (child.type === 'task') {
		if (typeof child.taskId !== 'string' || child.invocationId !== undefined || !isUuid(child.taskId)) {
			fail(record, `Task child reference has invalid discriminated identity.`);
		}
		return;
	}
	if (
		child.type !== 'action' ||
		typeof child.invocationId !== 'string' ||
		child.taskId !== undefined ||
		!isUuid(child.invocationId)
	) {
		fail(record, `Action child reference has invalid discriminated identity.`);
	}
}

export function getActiveConversationPath(conversation: ReducedConversationState): ReducedEntry[] {
	const path: ReducedEntry[] = [];
	const visited = new Set<string>();
	let current = conversation.activeLeafId
		? conversation.entries.get(conversation.activeLeafId)
		: undefined;
	while (current) {
		if (visited.has(current.id)) {
			throw new ConversationRecordInvariantError({
				recordId: current.id,
				recordType: current.type,
				reason: `Conversation graph contains a cycle at "${current.id}".`,
			});
		}
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : undefined;
	}
	return path.reverse();
}

export function buildConversationContextEntries(
	conversation: ReducedConversationState,
	options: ConversationProjectionOptions = {},
): ReducedContextEntry[] {
	const path = getActiveConversationPath(conversation);
	const latestCompactionIndex = path.findLastIndex((entry) => entry.type === 'compaction');
	if (latestCompactionIndex === -1) return pathToContextEntries(path, options);
	const compaction = path[latestCompactionIndex] as ReducedCompactionEntry;
	const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
	return [
		{
			message: createUserContextMessage(
				renderSignalMessage({
					role: 'signal',
					type: 'context_summary',
					tagName: 'compaction',
					content: compaction.summary,
					timestamp: new Date(compaction.timestamp).getTime(),
				}),
				compaction.timestamp,
			),
			sourceEntry: compaction,
		},
		...pathToContextEntries(path.slice(keptStart, latestCompactionIndex), options),
		...pathToContextEntries(path.slice(latestCompactionIndex + 1), options),
	];
}

export function buildConversationContext(
	conversation: ReducedConversationState,
	options: ConversationProjectionOptions = {},
): AgentMessage[] {
	return buildConversationContextEntries(conversation, options).map((entry) => entry.message);
}

function pathToContextEntries(
	path: ReducedEntry[],
	options: ConversationProjectionOptions,
): ReducedContextEntry[] {
	const messages: ReducedContextEntry[] = [];
	let index = 0;
	while (index < path.length) {
		const entry = path[index];
		if (!entry || entry.type !== 'message') {
			index += 1;
			continue;
		}
		const message = resolveMessageAttachments(entry, options);
		if (message.role === 'signal') {
			messages.push({
				message: createUserContextMessage(renderSignalMessage(message), entry.timestamp),
				sourceEntry: entry,
			});
			index += 1;
			continue;
		}
		if (message.role === 'assistant') {
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				const next = path[index + 1];
				const afterNext = path[index + 2];
				const resumable =
					message.stopReason === 'aborted' &&
					next?.type === 'message' &&
					next.message.role === 'signal' &&
					next.message.type === 'stream_interrupted' &&
					afterNext?.type === 'message' &&
					afterNext.message.role === 'signal' &&
					afterNext.message.type === 'stream_continued';
				if (!resumable) {
					index += 1;
					continue;
				}
			}
			const toolCalls = message.content.filter((block) => block.type === 'toolCall');
			if (toolCalls.length > 0) {
				const results: ToolResultMessage[] = [];
				let resultIndex = index + 1;
				while (resultIndex < path.length) {
					const result = path[resultIndex];
					if (result?.type !== 'message' || result.message.role !== 'toolResult') break;
					results.push(resolveMessageAttachments(result, options) as ToolResultMessage);
					resultIndex += 1;
				}
				if (isCompleteToolBatch(toolCalls, results)) {
					messages.push({ message, sourceEntry: entry });
					for (let resultOffset = 0; resultOffset < results.length; resultOffset++) {
						const resultEntry = path[index + 1 + resultOffset];
						const result = results[resultOffset];
						if (resultEntry && result) messages.push({ message: result, sourceEntry: resultEntry });
					}
				}
				index = resultIndex;
				continue;
			}
			messages.push({ message, sourceEntry: entry });
			index += 1;
			continue;
		}
		if (message.role !== 'toolResult') messages.push({ message, sourceEntry: entry });
		index += 1;
	}
	return messages;
}

function appendEntry(
	state: ReducedInstanceState,
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entry: ReducedEntry,
): void {
	assertEntryAppend(state, conversation, record, entry.id, entry.parentId);
	commitEntry(state, conversation, entry);
}

function assertEntryAppend(
	state: ReducedInstanceState,
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entryId: string,
	parentId: string | null,
): void {
	if (!entryId.startsWith('entry_')) fail(record, `Graph entry ids must use the "entry_" prefix.`);
	const owner = state.entryOwners.get(entryId);
	if (owner && owner !== conversation.conversationId) {
		fail(record, `Graph entry "${entryId}" belongs to another conversation.`);
	}
	if (conversation.entries.has(entryId) || conversation.inProgressMessages.has(entryId)) {
		fail(record, `Graph entry "${entryId}" already exists.`);
	}
	assertParent(conversation, record, parentId);
	if (parentId !== conversation.activeLeafId) {
		fail(
			record,
			`Entry parent "${String(parentId)}" is not the active leaf "${String(conversation.activeLeafId)}". Append active_leaf_changed before creating a branch.`,
		);
	}
	if (conversation.inProgressMessages.size > 0) {
		fail(record, `Cannot advance the conversation while an assistant message is in progress.`);
	}
}

function commitEntry(
	state: ReducedInstanceState,
	conversation: ReducedConversationState,
	entry: ReducedEntry,
): void {
	conversation.entries.set(entry.id, entry);
	conversation.activeLeafId = entry.id;
	state.entryOwners.set(entry.id, conversation.conversationId);
}

function assertAssistantCompletionAppend(
	state: ReducedInstanceState,
	conversation: ReducedConversationState,
	record: ConversationRecord,
	message: InProgressAssistantMessage,
): void {
	if (!message.messageId.startsWith('entry_')) {
		fail(record, `Graph entry ids must use the "entry_" prefix.`);
	}
	const owner = state.entryOwners.get(message.messageId);
	if (owner && owner !== conversation.conversationId) {
		fail(record, `Graph entry "${message.messageId}" belongs to another conversation.`);
	}
	if (conversation.entries.has(message.messageId)) {
		fail(record, `Graph entry "${message.messageId}" already exists.`);
	}
	assertParent(conversation, record, message.parentId);
	if (message.parentId !== conversation.activeLeafId) {
		fail(record, `Assistant parent is no longer the active leaf.`);
	}
}

function assertParent(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	parentId: string | null,
): void {
	if (parentId !== null && !conversation.entries.has(parentId)) {
		fail(record, `Parent entry "${parentId}" does not exist in this conversation.`);
	}
}

function pathToLeaf(
	conversation: ReducedConversationState,
	leafId: string,
): ReducedEntry[] {
	const path: ReducedEntry[] = [];
	let current = conversation.entries.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function getInProgress(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	messageId: string,
): InProgressAssistantMessage {
	const message = conversation.inProgressMessages.get(messageId);
	if (!message) fail(record, `Assistant message "${messageId}" is not in progress.`);
	return message;
}

function startBlock(
	message: InProgressAssistantMessage,
	record: ConversationRecord,
	block: ReducedAssistantBlock,
): void {
	if (!Number.isInteger(block.blockIndex) || block.blockIndex < 0) {
		fail(record, `Block index must be a non-negative integer.`);
	}
	if (message.blocks.has(block.blockId)) fail(record, `Block "${block.blockId}" already exists.`);
	if (message.blockIndexes.has(block.blockIndex)) {
		fail(record, `Block index "${block.blockIndex}" already exists in this message.`);
	}
	message.blocks.set(block.blockId, block);
	message.blockIndexes.add(block.blockIndex);
}

function appendDelta(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_delta' | 'assistant_reasoning_delta' }
	>,
	type: 'text' | 'reasoning',
): void {
	const message = getInProgress(conversation, record, record.messageId);
	const block = message.blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.sequence !== block.deltas.length) {
		fail(record, `Expected delta sequence ${block.deltas.length}, received ${record.sequence}.`);
	}
	block.deltas.push(record.delta);
}

function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'text',
): ReducedAssistantTextBlock;
function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'reasoning',
): ReducedAssistantReasoningBlock;
function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'text' | 'reasoning',
): ReducedAssistantTextBlock | ReducedAssistantReasoningBlock {
	const message = getInProgress(conversation, record, record.messageId);
	const block = message.blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.deltaCount !== block.deltas.length) {
		fail(record, `Completion expected ${record.deltaCount} deltas but replay has ${block.deltas.length}.`);
	}
	block.completed = true;
	return block;
}

function materializeAssistantBlock(
	block: ReducedAssistantBlock,
): AssistantMessage['content'][number] {
	if (block.type === 'text') {
		return {
			type: 'text',
			text: block.deltas.join(''),
			textSignature: block.textSignature,
		};
	}
	if (block.type === 'reasoning') {
		return {
			type: 'thinking',
			thinking: block.deltas.join(''),
			thinkingSignature: block.encrypted,
			redacted: block.redacted,
		};
	}
	return {
		type: 'toolCall',
		id: block.toolCallId,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature,
	};
}

function attachmentRefs(
	content: Array<CanonicalUserContent | CanonicalToolResultContent>,
): Map<string, AttachmentRef> | undefined {
	const refs = content.flatMap((block) => (block.type === 'attachment' ? [block.attachment] : []));
	return refs.length > 0 ? new Map(refs.map((ref) => [ref.id, ref])) : undefined;
}

function userMessage(content: CanonicalUserContent[], timestamp: string): AgentMessage {
	return {
		role: 'user',
		content: content.map((block) =>
			block.type === 'text'
				? block
				: {
						type: 'image' as const,
						data: block.attachment.id,
						mimeType: block.attachment.mimeType,
					},
		),
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

function toolResultMessage(
	record: Extract<ConversationRecord, { type: 'tool_outcome' }>,
): AgentMessage {
	return {
		role: 'toolResult',
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		isError: record.isError,
		content: record.content.map((block) =>
			block.type === 'text'
				? block
				: {
						type: 'image' as const,
						data: block.attachment.id,
						mimeType: block.attachment.mimeType,
					},
		),
		timestamp: new Date(record.timestamp).getTime(),
	} as ToolResultMessage as AgentMessage;
}

function resolveMessageAttachments(
	entry: ReducedMessageEntry,
	options: ConversationProjectionOptions,
): AgentMessage {
	const message = entry.message;
	if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content)) {
		return message;
	}
	const attachments = [...(entry.attachmentRefs?.values() ?? [])];
	let manifestProjected = false;
	const content = message.content.map((block) => {
		if (block.type === 'text' && !manifestProjected && attachments.length > 0) {
			manifestProjected = true;
			return { ...block, text: attachmentManifest(block.text, attachments) };
		}
		if (block.type !== 'image') return block;
		const ref = entry.attachmentRefs?.get(block.data);
		if (!ref) return block;
		if (!options.resolveAttachment) throw new AttachmentNotAvailableError({ attachmentId: ref.id });
		return { type: 'image' as const, ...options.resolveAttachment(ref) };
	});
	if (!manifestProjected && attachments.length > 0) {
		content.unshift({ type: 'text', text: attachmentManifest('', attachments) });
	}
	return { ...message, content } as AgentMessage;
}

function attachmentManifest(text: string, attachments: readonly AttachmentRef[]): string {
	if (attachments.length === 0) return text;
	const manifest = attachments
		.map((attachment) => `<image id="${attachment.id}" mimeType="${attachment.mimeType}" />`)
		.join('\n');
	const projection = `\n\n<attachments>\n${manifest}\n</attachments>`;
	return text.endsWith(projection) ? text : `${text}${projection}`;
}

function isCompleteToolBatch(
	toolCalls: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>[],
	results: ToolResultMessage[],
): boolean {
	if (toolCalls.length !== results.length) return false;
	const seen = new Set<string>();
	for (let index = 0; index < toolCalls.length; index++) {
		const call = toolCalls[index];
		const result = results[index];
		if (!call || !result || seen.has(call.id)) return false;
		seen.add(call.id);
		if (result.toolCallId !== call.id || result.toolName !== call.name) return false;
	}
	return true;
}

export function toolOutcomeKey(assistantMessageId: string, toolCallId: string): string {
	return JSON.stringify([assistantMessageId, toolCallId]);
}

export function toolResultEntryId(assistantMessageId: string, toolCallId: string): string {
	return `entry_tool_result_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`;
}

function encodeCanonicalId(id: string): string {
	const bytes = new TextEncoder().encode(id);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function conversationScopeKey(harness: string, session: string): string {
	return JSON.stringify([harness, session]);
}

function fail(record: ConversationRecord, reason: string): never {
	throw new ConversationRecordInvariantError({
		recordId: record.id,
		recordType: record.type,
		reason,
	});
}
