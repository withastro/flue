import type { AttachmentRef } from './conversation-records.ts';
import type {
	InProgressAssistantMessage,
	ReducedCompactionEntry,
	ReducedConversationState,
	ReducedEntry,
	ReducedMessageEntry,
} from './conversation-reducer.ts';
import { getActiveConversationPath } from './conversation-reducer.ts';
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
	// A named client-facing data part (`useDataWriter`), AI SDK convention:
	// the part type is `data-<name>` and the payload rides `data`.
	| { type: `data-${string}`; data: unknown }
	// `url` mirrors the SDK shape but is never set server-side (the runtime does
	// not know the HTTP mount/baseUrl); the SDK fills it in for consumers.
	| { type: 'file'; mediaType: string; id?: string; size?: number; url?: string; filename?: string }
	| ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
			| { state: 'input-available'; input: unknown }
			// `durationMs` is the tool-handler execution time; present once the
			// outcome is known (absent on outcomes recorded before the field).
			| { state: 'output-available'; input: unknown; output: unknown; durationMs?: number }
			| { state: 'output-error'; input: unknown; errorText: string; durationMs?: number }
	  ));

/**
 * Coarse render lane for a materialized message. `system` covers every
 * non-chat, non-answer message (internal control input and runtime advisories),
 * mirroring the standard chat convention so a generic renderer can lay a
 * transcript out without understanding Flue's finer {@link ConversationMessagePurpose}.
 */
type ConversationMessageRole = 'user' | 'assistant' | 'system';

/**
 * Stable semantic classification of a message, independent of its rendered
 * text. Lets clients distinguish public chat, assistant answers, internal
 * dispatch/control input, and runtime advisories without parsing content,
 * ordering, or timestamps.
 *
 * The union is intentionally open to future widening (`activity`, `notification`,
 * `state`) as the runtime grows typed agent-activity and attached-agent signals;
 * only the currently-emitted values are listed here.
 */
export type ConversationMessagePurpose = 'user' | 'assistant' | 'dispatch' | 'advisory';

/**
 * How a transcript UI should treat a message: `visible` for primary chat,
 * `diagnostic` for content a client may surface in an activity/diagnostics
 * panel, `hidden` for runtime plumbing that should not normally be shown.
 */
export type ConversationMessageDisplay = 'visible' | 'hidden' | 'diagnostic';

/**
 * Typed detail for a message projected from an internal signal record. Present
 * only on `system`-role messages. `tagName` is the signal's stable label and
 * `attributes` its structured metadata; both carry across history snapshots and
 * live updates so clients can subtype or correlate signals without parsing text.
 */
interface ConversationSignalDescriptor {
	tagName?: string;
	attributes?: Record<string, string>;
}

export interface ConversationUiMessage {
	/**
	 * Stable message identity. An assistant message represents one whole
	 * response: every model step of a tracked submission folds into the
	 * submission's first assistant message (parts accumulate across steps in
	 * record order), so `id` is the first step's message id.
	 */
	id: string;
	role: ConversationMessageRole;
	/** Stable semantic classification; see {@link ConversationMessagePurpose}. */
	purpose: ConversationMessagePurpose;
	/** Render/visibility hint; see {@link ConversationMessageDisplay}. */
	display: ConversationMessageDisplay;
	/** Present on messages produced by a tracked submission. */
	submissionId?: string;
	/**
	 * Stable per-turn grouping identity. Shared by every message recorded within
	 * one model round-trip; absent on messages recorded outside a turn.
	 */
	turnId?: string;
	/** Typed signal detail; present only on `system`-role messages. */
	signal?: ConversationSignalDescriptor;
	parts: ConversationUiPart[];
	/**
	 * Message metadata is entirely agent-authored (`useResponseStart`/`useResponseFinish`
	 * producers, deep-merged in call order). The runtime stamps nothing — keys
	 * like `timestamp`, `usage`, or `model` are app conventions, present only
	 * when the agent attaches them.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Map an internal signal type to its stable public classification. Keeps the
 * canonical signal vocabulary off the wire: only the derived `purpose`/`display`
 * cross the contract, so internal signal types can evolve without changing it.
 *
 * The runtime itself only ever writes the handful of internal signal types
 * enumerated below (recovery advisories and terminal-outcome markers) — every
 * other signal type is caller-defined, written only by a `dispatch()` call
 * delivering a `kind: 'signal'` message (see the phase 2 unified-delivery
 * plan). That's why `default` classifies as `purpose: 'dispatch'` rather than
 * `'advisory'`: by construction, anything reaching `default` arrived through
 * dispatch, not from the runtime's own internal bookkeeping.
 */
export function classifySignal(signalType: string): {
	purpose: ConversationMessagePurpose;
	display: ConversationMessageDisplay;
} {
	switch (signalType) {
		case 'stream_interrupted':
		case 'stream_continued':
			return { purpose: 'advisory', display: 'hidden' };
		case 'submission_aborted':
		case 'submission_interrupted':
			return { purpose: 'advisory', display: 'diagnostic' };
		// Dynamic-resource narration: runtime bookkeeping announcing that the
		// declared tools/skills/subagents changed, not a caller dispatch.
		case 'resources':
		// Instruction-change narration: the composed instruction document
		// moved between renders; announcement only, same bookkeeping family.
		case 'instructions':
		// Environment-swap narration: a conditional sandbox attached, detached,
		// or was replaced at a turn boundary; full-snapshot announcement, same
		// bookkeeping family.
		case 'environment':
			return { purpose: 'advisory', display: 'diagnostic' };
		default:
			return { purpose: 'dispatch', display: 'diagnostic' };
	}
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

/**
 * Classify how far a persisted submission input progressed, from the
 * conversation's committed entries. In-progress bookkeeping is deliberately
 * NOT consulted: structural convergence (`materializeGhostStream`) runs at
 * every ownership seam before classification, so an interrupted stream is
 * always a committed aborted entry by the time a consumer classifies — never
 * a special in-progress state.
 */
export function classifyConversationSubmission(
	conversation: ReducedConversationState,
	inputEntryId: string,
	options: { contextWindow: number },
): SubmissionState {
	const path = getActiveConversationPath(conversation);
	const inputIndex = path.findIndex((entry) => entry.id === inputEntryId);
	if (inputIndex === -1) return classifySubmissionState(undefined, options);
	// The input entry's own stamp identifies the submission being classified,
	// so joined-delivery user messages absorbed into its response are read as
	// continuation input rather than the session advancing past the input.
	return classifySubmissionState(path.slice(inputIndex + 1), {
		...options,
		ownSubmissionId: path[inputIndex]?.submissionId,
	});
}

export function projectConversationUi(
	conversation: ReducedConversationState,
	streamOffset: string,
): ConversationUiSnapshot {
	const messages: ConversationUiMessage[] = [];
	const byId = new Map<string, ConversationUiMessage>();
	// One UI message per assistant response (the UIMessage ecosystem shape):
	// every assistant step of a tracked submission folds into the submission's
	// first assistant message, parts accumulating across steps in record order.
	const responseBySubmission = new Map<string, ConversationUiMessage>();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== 'message') continue;
		const projected = projectCompletedMessage(entry);
		if (projected) {
			if (projected.role === 'assistant' && projected.submissionId) {
				const open = responseBySubmission.get(projected.submissionId);
				if (open) {
					mergeAssistantContinuation(open, projected);
					appendAnchoredDataParts(open, conversation, projected.submissionId, projected.id);
					continue;
				}
				responseBySubmission.set(projected.submissionId, projected);
				appendAnchoredDataParts(projected, conversation, projected.submissionId, projected.id);
				applyResponseMetadata(projected, conversation);
			}
			messages.push(projected);
			byId.set(projected.id, projected);
			continue;
		}
		if (entry.message.role !== 'toolResult') continue;
		const toolResult = entry.message;
		for (let index = messages.length - 1; index >= 0; index--) {
			const candidate = messages[index];
			// toolCallIds are only unique per assistant step (the reducer keys
			// outcomes by assistant message), and steps of one submission merge
			// into one response message — so backfill the latest matching call
			// still awaiting output, never a part that already resolved.
			const partIndex =
				candidate?.parts.findLastIndex(
					(value) =>
						value.type === 'dynamic-tool' &&
						value.toolCallId === toolResult.toolCallId &&
						value.state === 'input-available',
				) ?? -1;
			if (!candidate || partIndex < 0) continue;
			const part = candidate.parts[partIndex] as Extract<
				ConversationUiPart,
				{ type: 'dynamic-tool' }
			>;
			candidate.parts[partIndex] = toolResult.isError
				? {
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						state: 'output-error',
						input: part.input,
						errorText: toolResultText(toolResult.content),
						...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					}
				: {
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						state: 'output-available',
						input: part.input,
						output: entry.toolOutput
							? entry.toolOutput.value
							: toolResultOutput(toolResult.content),
						...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					};
			break;
		}
	}
	for (const inProgress of conversation.inProgressMessages.values()) {
		const projected = projectInProgressMessage(inProgress);
		if (!projected || byId.has(projected.id)) continue;
		// A live continuation stream (parented on the current leaf) extends its
		// submission's open response message. Anything else — e.g. a ghost
		// partial from an interrupted attempt awaiting terminalization —
		// projects standalone, as before.
		const open =
			projected.submissionId && inProgress.parentId === conversation.activeLeafId
				? responseBySubmission.get(projected.submissionId)
				: undefined;
		if (open) {
			mergeAssistantContinuation(open, projected);
			continue;
		}
		if (projected.submissionId) applyResponseMetadata(projected, conversation);
		messages.push(projected);
	}
	return { conversationId: conversation.conversationId, streamOffset, messages };
}

/**
 * Fold a later assistant step of the same submission into its response
 * message: parts append in record order; identity fields (id, turnId) stay
 * the first step's.
 */
function mergeAssistantContinuation(
	open: ConversationUiMessage,
	continuation: ConversationUiMessage,
): void {
	open.parts.push(...continuation.parts);
}

/**
 * Append the response's data parts anchored to one assistant step, right
 * after that step's own parts — the position a live client saw them stream
 * into. First-write order within a step; a rewrite updated `data` in place.
 */
function appendAnchoredDataParts(
	message: ConversationUiMessage,
	conversation: ReducedConversationState,
	submissionId: string,
	anchorEntryId: string,
): void {
	const parts = conversation.responseDataParts.get(submissionId);
	if (!parts) return;
	for (const part of parts) {
		if (part.anchorEntryId !== anchorEntryId) continue;
		message.parts.push({ type: `data-${part.name}`, data: part.data });
	}
}

/** Attach the response's agent-authored metadata (`useResponseStart`/`useResponseFinish`). */
function applyResponseMetadata(
	message: ConversationUiMessage,
	conversation: ReducedConversationState,
): void {
	if (!message.submissionId) return;
	const custom = conversation.responseMetadata.get(message.submissionId);
	if (custom) message.metadata = custom;
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
			purpose: 'user',
			display: 'visible',
			...(entry.submissionId ? { submissionId: entry.submissionId } : {}),
			...(entry.turnId ? { turnId: entry.turnId } : {}),
			parts,
		};
	}
	if (message.role === 'signal') {
		const { purpose, display } = classifySignal(message.type);
		const signal: ConversationSignalDescriptor = {
			...(message.tagName ? { tagName: message.tagName } : {}),
			...(message.attributes ? { attributes: message.attributes } : {}),
		};
		return {
			id: entry.id,
			role: 'system',
			purpose,
			display,
			...(entry.submissionId ? { submissionId: entry.submissionId } : {}),
			...(entry.turnId ? { turnId: entry.turnId } : {}),
			...(Object.keys(signal).length > 0 ? { signal } : {}),
			parts: [{ type: 'text', text: message.content, state: 'done' }],
		};
	}
	if (message.role !== 'assistant') return undefined;
	return {
		id: entry.id,
		role: 'assistant',
		purpose: 'assistant',
		display: 'visible',
		submissionId: entry.submissionId,
		...(entry.turnId ? { turnId: entry.turnId } : {}),
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
	};
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
		purpose: 'assistant',
		display: 'visible',
		// Carry submissionId/turnId so a mid-stream snapshot (e.g. a reset forced
		// by compaction) reprojects the same grouping identity the live
		// `message-started` chunk and the completed projection already emit.
		...(message.submissionId ? { submissionId: message.submissionId } : {}),
		...(message.turnId ? { turnId: message.turnId } : {}),
		parts,
	};
}
