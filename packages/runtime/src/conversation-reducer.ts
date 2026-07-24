import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
	type AssistantMessageStartedRecord,
	type AttachmentRef,
	type CanonicalChildSessionRef,
	type CanonicalToolResultContent,
	type CanonicalUserContent,
	type CompactionRecord,
	type ConversationRecord,
	encodeCanonicalId,
} from './conversation-records.ts';
import { AttachmentNotAvailableError, ConversationRecordInvariantError } from './errors.ts';
import { fnv1a64 } from './fnv.ts';
import { deepMergeMetadata } from './message-output.ts';
import { createUserContextMessage, renderSignalMessage } from './message-rendering.ts';
import type { ResourceSnapshot } from './resources.ts';
import {
	createActionScopeName,
	createTaskSessionName,
	isDurableInvocationId,
	isDurableTaskId,
	isPublicSessionName,
} from './session-identity.ts';

interface ReducedEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
	/**
	 * Turn this entry was recorded under, when one was active. Carried from the
	 * canonical record envelope so the public projection can expose a stable
	 * per-turn grouping identity. Absent on entries recorded outside a turn
	 * (e.g. a user message queued before the first model round-trip).
	 */
	turnId?: string;
}

export interface ReducedMessageEntry extends ReducedEntryBase {
	type: 'message';
	message: AgentMessage;
	attachmentRefs?: Map<string, AttachmentRef>;
	/**
	 * Validated structured tool output for tool-result entries, distinct from the
	 * model-facing `message` content. Present only when the tool declared one.
	 */
	toolOutput?: { value: unknown };
	/**
	 * Tool-handler execution time (ms) for tool-result entries, carried from the
	 * durable tool outcome. Absent on entries whose outcome predates the field.
	 */
	toolDurationMs?: number;
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
	ReducedAssistantTextBlock | ReducedAssistantReasoningBlock | ReducedAssistantToolCallBlock;

export interface InProgressAssistantMessage {
	messageId: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
	turnId?: string;
	modelInfo: AssistantMessageStartedRecord['modelInfo'];
	blocks: Map<string, ReducedAssistantBlock>;
	blockIndexes: Set<number>;
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
	/**
	 * Durable tool outcomes of the UNCOMMITTED batch by
	 * `toolOutcomeKey(assistantMessageId, toolCallId)`, valued by the
	 * `tool_outcome` record id. Presence/identity index for the window
	 * between outcome and commit — repair and resume paths check it before
	 * re-resolving a call. The batch's own `tool_results_committed` consumes
	 * its keys: the content then lives on the committed tool-result entries.
	 */
	toolOutcomes: Map<string, string>;
	childConversations: Map<string, CanonicalChildSessionRef>;
	/**
	 * Custom response metadata per submission: `responseMetadata` from the
	 * response's first `assistant_message_started` plus every later
	 * `message_metadata` record, deep-merged in stream order. Projected onto
	 * the response message under the server-authored keys.
	 */
	responseMetadata: Map<string, Record<string, unknown>>;
	/**
	 * Client-facing data parts per submission (`message_data_write`), in
	 * first-write order. Each part is anchored after the assistant step that
	 * had completed when it was first written; a later write to the same name
	 * updates `data` in place, keeping the anchor.
	 */
	responseDataParts: Map<string, ResponseDataPart[]>;
	/** Last completed assistant entry per submission — the data-write anchor. */
	lastAssistantEntryBySubmission: Map<string, string>;
}

interface ResponseDataPart {
	name: string;
	anchorEntryId: string;
	data: unknown;
}

export type ReducedConversationState = ReducedConversationStateBase &
	(
		| {
				kind: 'root';
				parentConversationId?: never;
				taskId?: never;
				actionInvocationId?: never;
				agent?: never;
		  }
		| {
				kind: 'task';
				parentConversationId: string;
				taskId: string;
				actionInvocationId?: never;
				agent?: string;
		  }
		| {
				kind: 'action';
				parentConversationId: string;
				actionInvocationId: string;
				taskId?: never;
				agent?: never;
		  }
	);

/**
 * Post-fold residue of a record whose body has no reader once the fold has
 * applied it: the FNV-1a 64 digest of the record's canonical JSON. The map
 * key carries presence; the digest carries the id-reuse invariant (a
 * replayed record must hash to the same content).
 */
interface DroppedRecordStub {
	h: string;
	type?: never;
}

/**
 * Residue of an applied `assistant_message_started`: the envelope fields the
 * settlement-attribution scan reads (`assistantSubmissionByAttempt`), plus
 * the dedup digest.
 */
interface AssistantMessageStartedStub {
	h: string;
	type: 'assistant_message_started';
	conversationId: string;
	attemptId?: string;
	submissionId?: string;
}

/**
 * Residue of a `tool_outcome` whose commit has folded: the fields the
 * response tool-call scan reads (`collectResponseToolCalls`), plus the dedup
 * digest. The result content lives on the committed tool-result entry.
 */
interface ToolOutcomeStub {
	h: string;
	type: 'tool_outcome';
	conversationId: string;
	submissionId?: string;
	toolName: string;
	isError: boolean;
}

type ConversationRecordStub = DroppedRecordStub | AssistantMessageStartedStub | ToolOutcomeStub;

/**
 * One `recordsById` value: the full record for the retain-set (types whose
 * bodies are read after the fold), a stub otherwise. The map is the fold's
 * idempotency index, not an archive — the log store holds the bytes.
 */
export type IndexedConversationRecord = ConversationRecord | ConversationRecordStub;

function isConversationRecordStub(
	value: IndexedConversationRecord,
): value is ConversationRecordStub {
	return 'h' in value;
}

export interface ReducedInstanceState {
	recordsThroughOffset: string;
	conversations: Map<string, ReducedConversationState>;
	conversationScopes: Map<string, string>;
	/**
	 * Every applied record by id — the dedup/idempotency index for replayed
	 * and deterministic-id records. Bodies are retained only for the types
	 * with post-fold readers (settlement compares, durable step memos,
	 * submission-scoped scans); everything else downgrades to a
	 * {@link ConversationRecordStub} at application so resident state stays
	 * an index over the log instead of a second copy of it.
	 */
	recordsById: Map<string, IndexedConversationRecord>;
	/**
	 * Hook state (`usePersistentState`) snapshot: last-write-wins per name across every
	 * `state_write` record in the instance's stream, in stream order. Scoped to
	 * the agent instance (its whole stream), not to one conversation — this is
	 * the agent's durable memory, readable by any render of the instance.
	 */
	state: Map<string, unknown>;
	/**
	 * Instance-creation data from the root conversation's
	 * `conversation_created` record. Present (as a box) once the root
	 * conversation exists — `value` may itself be undefined when creation
	 * carried no data. Absent before first contact.
	 */
	initialData?: { value: unknown };
	/**
	 * The instance uid from the root conversation's birth record. Absent
	 * before first contact and for instances created before uids shipped.
	 */
	uid?: string;
	/**
	 * Dynamic-resource bookkeeping from `resource_snapshot` records, scoped
	 * to the instance like hook state. `narrated` is what the model was last
	 * told exists (the diff base for the next narration); `baseline` is the
	 * frozen-presentation snapshot (system-prompt skill catalog, task-tool
	 * roster), reset at first contact and at each compaction rebaseline.
	 * Absent for instances that never wrote a snapshot.
	 */
	resources?: { baseline?: ResourceSnapshot; narrated: ResourceSnapshot };
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
		state: new Map(),
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

/**
 * Fold one batch into `state` directly, without the failure-atomicity clone.
 * For from-scratch loads, which discard the partial state when a record
 * throws; an incremental writer needs {@link reduceConversationRecords},
 * whose clone keeps the accepted state intact when a later record in the
 * batch is invalid.
 */
export function reduceConversationRecordsInPlace(
	state: ReducedInstanceState,
	records: readonly ConversationRecord[],
	offset: string,
): void {
	for (const record of records) applyConversationRecord(state, record);
	state.recordsThroughOffset = offset;
}

function cloneReducedInstanceState(state: ReducedInstanceState): ReducedInstanceState {
	return {
		recordsThroughOffset: state.recordsThroughOffset,
		conversationScopes: new Map(state.conversationScopes),
		recordsById: new Map(state.recordsById),
		state: new Map(state.state),
		...(state.initialData ? { initialData: state.initialData } : {}),
		...(state.uid !== undefined ? { uid: state.uid } : {}),
		// Snapshots are replaced immutably on update, so carrying the box is safe.
		...(state.resources ? { resources: { ...state.resources } } : {}),
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
					toolOutcomes: new Map(conversation.toolOutcomes),
					childConversations: new Map(conversation.childConversations),
					// Values are replaced immutably on update, so shallow copies suffice.
					responseMetadata: new Map(conversation.responseMetadata),
					responseDataParts: new Map(
						[...conversation.responseDataParts].map(([submissionId, parts]) => [
							submissionId,
							[...parts],
						]),
					),
					lastAssistantEntryBySubmission: new Map(conversation.lastAssistantEntryBySubmission),
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
		// A stub compares by the digest of the record's canonical JSON — the
		// same equality relation as the retained byte-for-byte compare.
		const identical = isConversationRecordStub(accepted)
			? accepted.h === fnv1a64(JSON.stringify(record))
			: JSON.stringify(accepted) === JSON.stringify(record);
		if (identical) return;
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
			responseMetadata: new Map(),
			responseDataParts: new Map(),
			lastAssistantEntryBySubmission: new Map(),
		});
		state.conversationScopes.set(scopeKey, record.conversationId);
		state.recordsById.set(record.id, indexConversationRecord(record));
		if (record.kind === 'root') {
			// First root wins: initialData is the instance's birth data, recorded
			// once. A named session opens a second root whose record carries no
			// initialData — it must not clobber the birth value. Mirrors the uid
			// guard directly below.
			if (state.initialData === undefined) state.initialData = { value: record.initialData };
			if (record.uid !== undefined) state.uid = record.uid;
		}
		return;
	}

	const conversation = state.conversations.get(record.conversationId);
	if (!conversation) fail(record, `Conversation "${record.conversationId}" is not initialized.`);
	if (conversation.harness !== record.harness || conversation.session !== record.session) {
		fail(record, `Conversation scope conflicts with its creation record.`);
	}
	switch (record.type) {
		case 'user_message':
			appendEntry(conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
				message: userMessage(record.content, record.timestamp),
				attachmentRefs: attachmentRefs(record.content),
			});
			break;
		case 'signal':
			appendEntry(conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
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
				fail(
					record,
					`Assistant parent "${String(record.parentId)}" is not the conversation tail. Appends are linear.`,
				);
			}
			if (
				conversation.entries.has(record.messageId) ||
				conversation.inProgressMessages.has(record.messageId)
			) {
				fail(record, `Assistant entry "${record.messageId}" already exists.`);
			}
			// A next turn must never stream on top of an uncommitted tool
			// batch: its completion would bury the batch exactly like a direct
			// entry append (see `hasUncommittedToolBatchAtLeaf`).
			if (hasUncommittedToolBatchAtLeaf(conversation)) {
				fail(record, `Cannot advance the conversation while a tool batch is uncommitted.`);
			}
			conversation.inProgressMessages.set(record.messageId, {
				messageId: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
				modelInfo: record.modelInfo,
				blocks: new Map(),
				blockIndexes: new Set(),
			});
			if (record.responseMetadata) {
				if (!record.submissionId) {
					fail(record, `Response metadata requires a tracked submission.`);
				}
				mergeResponseMetadata(conversation, record.submissionId, record.responseMetadata);
			}
			break;
		case 'assistant_text_started': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'text',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false,
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
		case 'assistant_text_completed': {
			const block = completeBlock(conversation, record, 'text');
			block.textSignature = record.textSignature;
			break;
		}
		case 'assistant_reasoning_completed': {
			const block = completeBlock(conversation, record, 'reasoning');
			block.encrypted = record.encrypted;
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
			assertAssistantCompletionAppend(conversation, record, inProgress);
			conversation.inProgressMessages.delete(record.messageId);
			commitEntry(conversation, {
				type: 'message',
				id: record.messageId,
				parentId: inProgress.parentId,
				timestamp: inProgress.timestamp,
				submissionId: inProgress.submissionId,
				turnId: inProgress.turnId,
				message,
			});
			if (inProgress.submissionId) {
				conversation.lastAssistantEntryBySubmission.set(inProgress.submissionId, record.messageId);
			}
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
			conversation.toolOutcomes.set(outcomeKey, record.id);
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
			if (
				record.parentId !== record.assistantMessageId ||
				record.parentId !== conversation.activeLeafId
			) {
				fail(record, `Committed tool results must extend their active assistant parent.`);
			}
			const calls = assistant.message.content.filter((block) => block.type === 'toolCall');
			if (
				record.outcomeIds.length !== calls.length ||
				new Set(record.outcomeIds).size !== calls.length
			) {
				fail(
					record,
					`Committed tool results must reference every assistant tool call exactly once.`,
				);
			}
			const outcomes = record.outcomeIds.map((outcomeId, index) => {
				const outcomeRecord = state.recordsById.get(outcomeId);
				const call = calls[index];
				if (
					outcomeRecord?.type !== 'tool_outcome' ||
					isConversationRecordStub(outcomeRecord) ||
					!call ||
					outcomeRecord.conversationId !== record.conversationId ||
					outcomeRecord.harness !== record.harness ||
					outcomeRecord.session !== record.session ||
					outcomeRecord.assistantMessageId !== record.assistantMessageId ||
					outcomeRecord.toolCallId !== call.id ||
					outcomeRecord.toolName !== call.name ||
					conversation.toolOutcomes.get(toolOutcomeKey(record.assistantMessageId, call.id)) !==
						outcomeId
				) {
					fail(record, `Committed tool outcome references do not match assistant tool-call order.`);
				}
				return outcomeRecord;
			});
			let parentId = record.parentId;
			for (const outcome of outcomes) {
				const entryId = toolResultEntryId(record.assistantMessageId, outcome.toolCallId);
				assertEntryAppend(conversation, record, entryId, parentId);
				commitEntry(conversation, {
					type: 'message',
					id: entryId,
					parentId,
					timestamp: outcome.timestamp,
					submissionId: record.submissionId,
					message: toolResultMessage(outcome),
					attachmentRefs: attachmentRefs(outcome.content),
					...(outcome.output !== undefined ? { toolOutput: { value: outcome.output } } : {}),
					...(outcome.durationMs !== undefined ? { toolDurationMs: outcome.durationMs } : {}),
				});
				parentId = entryId;
				// The commit consumes its batch: the result content now lives on
				// the committed entry, so the pre-commit presence index and the
				// retained outcome body downgrade together. In-place set keeps
				// the map's insertion order for stream-order scans.
				conversation.toolOutcomes.delete(
					toolOutcomeKey(record.assistantMessageId, outcome.toolCallId),
				);
				state.recordsById.set(outcome.id, {
					h: fnv1a64(JSON.stringify(outcome)),
					type: outcome.type,
					conversationId: outcome.conversationId,
					...(outcome.submissionId !== undefined ? { submissionId: outcome.submissionId } : {}),
					toolName: outcome.toolName,
					isError: outcome.isError,
				});
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
			if (
				record.sourceLeafId !== record.parentId ||
				record.sourceLeafId !== conversation.activeLeafId
			) {
				fail(record, `Compaction source leaf must be its active parent.`);
			}
			if (
				!pathToLeaf(conversation, record.sourceLeafId).some(
					(entry) => entry.id === record.firstKeptEntryId,
				)
			) {
				fail(record, `Compaction first-kept entry is not on the source path.`);
			}
			appendEntry(conversation, record, {
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
		case 'child_session_retained': {
			validateChildReference(record);
			const child = state.conversations.get(record.child.conversationId);
			if (!child) fail(record, `Retained child conversation does not exist.`);
			const identityMatches =
				record.child.type === 'task'
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
			// Settle barrier: a settled submission can never legitimately complete
			// an assistant message it left in progress (attempt fencing rejects any
			// write past settlement), so drop its bookkeeping here. This is the
			// reducer-level guarantee that persisted history can never brick a
			// conversation past a settlement — and because the reducer is a pure
			// fold replayed on load, it retroactively heals streams poisoned by
			// crash windows that predate it. Content preservation is convergence's
			// job at the ownership seams; the barrier drops only bookkeeping.
			// Undefined-owner in-progress messages (programmatic prompts, subagent
			// children) are never dropped.
			if (record.submissionId) {
				for (const [messageId, message] of conversation.inProgressMessages) {
					if (message.submissionId === record.submissionId) {
						conversation.inProgressMessages.delete(messageId);
					}
				}
			}
			break;
		case 'tool_step_settled':
			// Durable-step memo: read back by deterministic id from
			// `recordsById` when a `durable: true` tool call re-executes.
			// Operational — no graph entry, so it can never enter model context.
			if (!record.toolCallId || !record.stepName) {
				fail(record, `A tool step memo requires its toolCallId and stepName.`);
			}
			break;
		case 'state_write':
			state.state.set(record.name, record.value);
			break;
		case 'resource_snapshot':
			state.resources = {
				narrated: record.snapshot,
				...(record.baseline
					? { baseline: record.snapshot }
					: state.resources?.baseline
						? { baseline: state.resources.baseline }
						: {}),
			};
			break;
		case 'agent_start_run':
		case 'agent_finish_cycle':
			// Lifecycle-hook bookkeeping: the session reads these straight from
			// `recordsById` (submission-scoped scans), no folded state needed.
			break;
		case 'message_metadata': {
			if (!record.submissionId) fail(record, `Response metadata requires a tracked submission.`);
			mergeResponseMetadata(conversation, record.submissionId, record.metadata);
			break;
		}
		case 'message_data_write': {
			if (!record.submissionId) {
				fail(record, `Message data writes require a tracked submission.`);
			}
			const anchorEntryId = conversation.lastAssistantEntryBySubmission.get(record.submissionId);
			if (!anchorEntryId) {
				fail(record, `Message data writes require a completed assistant step to anchor to.`);
			}
			const parts = conversation.responseDataParts.get(record.submissionId) ?? [];
			const index = parts.findIndex((part) => part.name === record.name);
			const next =
				index < 0
					? [...parts, { name: record.name, anchorEntryId, data: record.data }]
					: parts.map((part, partIndex) =>
							// A rewrite updates the data in place: the part keeps its
							// first-write anchor (and therefore its rendered position).
							partIndex === index ? { ...part, data: record.data } : part,
						);
			conversation.responseDataParts.set(record.submissionId, next);
			break;
		}
	}
	state.recordsById.set(record.id, indexConversationRecord(record));
}

/**
 * The `recordsById` value one applied record leaves behind. The retain-set is
 * exactly the types with post-fold body readers:
 *
 * - `submission_settled`: settlement finalization compares the durable record
 *   byte-for-byte against the retained obligation (agent-submissions.ts).
 * - `tool_step_settled`: a durable `step.do` re-execution replays `value`.
 * - `agent_start_run` / `agent_finish_cycle`: submission-scoped
 *   presence/count scans (already envelope-only records).
 * - `assistant_message_completed`: `collectResponseUsage` re-aggregates
 *   `usage` on resume.
 * - `tool_outcome`: its commit reads the body back to materialize tool-result
 *   entries; the commit handler downgrades it once that fold applies.
 *
 * Everything else drops to a digest stub, with `assistant_message_started`
 * keeping the envelope fields the settlement-attribution scan reads.
 */
function indexConversationRecord(record: ConversationRecord): IndexedConversationRecord {
	switch (record.type) {
		case 'submission_settled':
		case 'tool_step_settled':
		case 'agent_start_run':
		case 'agent_finish_cycle':
		case 'assistant_message_completed':
		case 'tool_outcome':
			return record;
		case 'assistant_message_started':
			return {
				h: fnv1a64(JSON.stringify(record)),
				type: record.type,
				conversationId: record.conversationId,
				...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
				...(record.submissionId !== undefined ? { submissionId: record.submissionId } : {}),
			};
		default:
			return { h: fnv1a64(JSON.stringify(record)) };
	}
}

function mergeResponseMetadata(
	conversation: ReducedConversationState,
	submissionId: string,
	metadata: Record<string, unknown>,
): void {
	const current = conversation.responseMetadata.get(submissionId);
	conversation.responseMetadata.set(
		submissionId,
		current ? deepMergeMetadata(current, metadata) : deepMergeMetadata({}, metadata),
	);
}

function validateConversationCreation(
	state: ReducedInstanceState,
	record: Extract<ConversationRecord, { type: 'conversation_created' }>,
): void {
	const value = record as ConversationRecord & Record<string, unknown>;
	if (value.kind === 'root') {
		if (
			value.parentConversationId !== undefined ||
			value.taskId !== undefined ||
			value.actionInvocationId !== undefined ||
			value.agent !== undefined
		) {
			fail(record, `Root conversation creation contains child identity fields.`);
		}
		return;
	}
	if (value.kind === 'task') {
		if (
			typeof value.parentConversationId !== 'string' ||
			typeof value.taskId !== 'string' ||
			value.actionInvocationId !== undefined ||
			!isDurableTaskId(value.taskId) ||
			(value.agent !== undefined && typeof value.agent !== 'string')
		) {
			fail(record, `Task conversation creation has invalid discriminated identity.`);
		}
		const parent = state.conversations.get(value.parentConversationId);
		if (!parent) return;
		if (
			record.harness !== parent.harness ||
			record.session !== createTaskSessionName(parent.session, value.taskId)
		) {
			fail(record, `Task conversation scope does not match its derived parent identity.`);
		}
		return;
	}
	if (
		value.kind !== 'action' ||
		typeof value.parentConversationId !== 'string' ||
		typeof value.actionInvocationId !== 'string' ||
		value.taskId !== undefined ||
		value.agent !== undefined ||
		!isDurableInvocationId(value.actionInvocationId)
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
		if (
			typeof child.taskId !== 'string' ||
			child.invocationId !== undefined ||
			!isDurableTaskId(child.taskId) ||
			(child.parentToolCallId !== undefined && typeof child.parentToolCallId !== 'string') ||
			(child.parentAssistantEntryId !== undefined &&
				typeof child.parentAssistantEntryId !== 'string')
		) {
			fail(record, `Task child reference has invalid discriminated identity.`);
		}
		return;
	}
	if (
		child.type !== 'action' ||
		typeof child.invocationId !== 'string' ||
		child.taskId !== undefined ||
		child.parentToolCallId !== undefined ||
		child.parentAssistantEntryId !== undefined ||
		!isDurableInvocationId(child.invocationId)
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
				// Positional adjacency IS the recovery contract: the signal pair
				// is appended only while the aborted partial is the leaf, so a
				// recovered partial is always immediately followed by its pair.
				// Classification applies the same rule (submission-state.ts,
				// `hasAdjacentStreamContinuation`) so it can never claim
				// "recovered" for a partial this builder excludes from context.
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
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entry: ReducedEntry,
): void {
	assertEntryAppend(conversation, record, entry.id, entry.parentId);
	commitEntry(conversation, entry);
}

function assertEntryAppend(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entryId: string,
	parentId: string | null,
): void {
	if (!entryId.startsWith('entry_')) fail(record, `Graph entry ids must use the "entry_" prefix.`);
	if (conversation.entries.has(entryId) || conversation.inProgressMessages.has(entryId)) {
		fail(record, `Graph entry "${entryId}" already exists.`);
	}
	assertParent(conversation, record, parentId);
	if (parentId !== conversation.activeLeafId) {
		fail(
			record,
			`Entry parent "${String(parentId)}" is not the conversation tail "${String(conversation.activeLeafId)}". Appends are linear.`,
		);
	}
	if (conversation.inProgressMessages.size > 0) {
		fail(record, `Cannot advance the conversation while an assistant message is in progress.`);
	}
	// The uncommitted-batch hold, mirroring the in-progress-message hold above:
	// the batch's own `tool_results_committed` is the only record that may
	// extend the leaf while it is held.
	if (record.type !== 'tool_results_committed' && hasUncommittedToolBatchAtLeaf(conversation)) {
		fail(record, `Cannot advance the conversation while a tool batch is uncommitted.`);
	}
}

/**
 * Whether the active leaf is a toolUse assistant whose result batch has not
 * committed — held from the moment such an assistant entry commits (it
 * becomes the leaf) until its own `tool_results_committed` moves the leaf to
 * the batch's last toolResult entry. While held, nothing may advance the
 * conversation: an entry appended on the toolUse leaf would bury the
 * uncommitted batch mid-history, where the context builder silently drops it
 * and repair can no longer commit it (the commit invariant requires the
 * assistant to still be the leaf). `tool_outcome` records and all non-entry
 * records are unaffected — they never move the leaf.
 */
function hasUncommittedToolBatchAtLeaf(conversation: ReducedConversationState): boolean {
	const leaf =
		conversation.activeLeafId !== null
			? conversation.entries.get(conversation.activeLeafId)
			: undefined;
	return (
		leaf?.type === 'message' &&
		leaf.message.role === 'assistant' &&
		leaf.message.stopReason === 'toolUse' &&
		leaf.message.content.some((block) => block.type === 'toolCall')
	);
}

function commitEntry(conversation: ReducedConversationState, entry: ReducedEntry): void {
	conversation.entries.set(entry.id, entry);
	conversation.activeLeafId = entry.id;
}

function assertAssistantCompletionAppend(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	message: InProgressAssistantMessage,
): void {
	if (!message.messageId.startsWith('entry_')) {
		fail(record, `Graph entry ids must use the "entry_" prefix.`);
	}
	if (conversation.entries.has(message.messageId)) {
		fail(record, `Graph entry "${message.messageId}" already exists.`);
	}
	assertParent(conversation, record, message.parentId);
	if (message.parentId !== conversation.activeLeafId) {
		fail(record, `Assistant parent is no longer the conversation tail.`);
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

function pathToLeaf(conversation: ReducedConversationState, leafId: string): ReducedEntry[] {
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
		fail(
			record,
			`Completion expected ${record.deltaCount} deltas but replay has ${block.deltas.length}.`,
		);
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
	if (
		(message.role !== 'user' && message.role !== 'toolResult') ||
		!Array.isArray(message.content)
	) {
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

export function conversationScopeKey(harness: string, session: string): string {
	return JSON.stringify([harness, session]);
}

function fail(record: ConversationRecord, reason: string): never {
	throw new ConversationRecordInvariantError({
		recordId: record.id,
		recordType: record.type,
		reason,
	});
}
