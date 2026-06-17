/** Session history: tree-structured entry storage with context-building logic. */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import { AttachmentNotAvailableError } from './errors.ts';
import type {
	CompactionEntry,
	DispatchMessageMetadata,
	MessageEntry,
	PromptImage,
	PromptUsage,
	SessionData,
	SessionEntry,
	SignalMessage,
	TaskSessionRef,
} from './types.ts';

export interface ContextEntry {
	message: AgentMessage;
	entry?: SessionEntry;
}

export interface CompactionAppendInput {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: PromptUsage;
}

export interface ResolvedImageAttachment {
	id: string;
	image: PromptImage;
}

export class SessionHistory {
	private entries: SessionEntry[];
	private byId: Map<string, SessionEntry>;
	private leafId: string | null;
	private imageAttachmentIds = new Map<string, Map<string, string>>();

	private constructor(entries: SessionEntry[], leafId: string | null) {
		this.entries = [...entries];
		this.leafId = leafId;
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		for (const entry of this.entries) {
			if (entry.type !== 'message' || !entry.attachments) continue;
			const content = getImageContent(entry.message);
			for (const attachment of entry.attachments) {
				const image = content?.[attachment.contentIndex];
				if (isPromptImage(image)) this.rememberImageAttachment(image, attachment.id);
			}
		}
	}

	static empty(): SessionHistory {
		return new SessionHistory([], null);
	}

	static fromData(data: SessionData | null): SessionHistory {
		if (!data) return SessionHistory.empty();
		if (data.version !== 6) {
			throw new Error(
				`[flue] Session data version ${String(data.version)} is unsupported. Clear persisted session state created by an earlier Flue beta.`,
			);
		}
		if (
			typeof data.affinityKey !== 'string' ||
			!/^aff_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(data.affinityKey)
		) {
			throw new Error(
				'[flue] Session data affinity key is malformed. Clear malformed persisted session state.',
			);
		}
		return new SessionHistory(data.entries, data.leafId);
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getActivePath(): SessionEntry[] {
		const path: SessionEntry[] = [];
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path.reverse();
	}

	/**
	 * Active-path entries appended after `afterLeafId` (exclusive), in order.
	 *
	 * - `afterLeafId === null` means "from the start of the path" → returns
	 *   the entire active path.
	 * - When the id is found, returns entries strictly after it.
	 * - When the id is *not* on the current active path (e.g. a branch
	 *   switch happened mid-window), returns `[]`. Callers use this for
	 *   bounded windowing — falling back to the full path would silently
	 *   include unrelated history. An empty result is the safer answer
	 *   for usage aggregation: zero is loud (sums won't match expectations)
	 *   while full-history is silent overcounting.
	 */
	getActivePathSince(afterLeafId: string | null): SessionEntry[] {
		const path = this.getActivePath();
		if (afterLeafId === null) return path;
		const startIndex = path.findIndex((entry) => entry.id === afterLeafId);
		if (startIndex === -1) return [];
		return path.slice(startIndex + 1);
	}

	buildContextEntries(): ContextEntry[] {
		const path = this.getActivePath();
		const latestCompactionIndex = findLatestCompactionIndex(path);
		if (latestCompactionIndex === -1) {
			return pathToContextEntries(path);
		}

		const compaction = path[latestCompactionIndex] as CompactionEntry;
		const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
		const context: ContextEntry[] = [
			{
				message: createContextSummaryMessage(compaction.summary, compaction.timestamp),
				entry: compaction,
			},
		];
		context.push(...pathToContextEntries(path.slice(keptStart, latestCompactionIndex)));
		context.push(...pathToContextEntries(path.slice(latestCompactionIndex + 1)));
		return context;
	}

	buildContext(): AgentMessage[] {
		return this.buildContextEntries().map((entry) => entry.message);
	}

	getLatestCompaction(): CompactionEntry | undefined {
		const path = this.getActivePath();
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i];
			if (entry?.type === 'compaction') return entry;
		}
		return undefined;
	}

	appendMessage(
		message: AgentMessage,
		metadata?: {
			dispatch?: DispatchMessageMetadata;
			directSubmissionId?: string;
			submissionTerminal?: MessageEntry['submissionTerminal'];
		},
	): string {
		const entry: MessageEntry = {
			type: 'message',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		const attachments = this.createAttachmentRefs(message);
		if (attachments.length > 0) entry.attachments = attachments;
		if (metadata?.dispatch) entry.dispatch = metadata.dispatch;
		if (metadata?.directSubmissionId) entry.directSubmissionId = metadata.directSubmissionId;
		if (metadata?.submissionTerminal) entry.submissionTerminal = metadata.submissionTerminal;
		this.appendEntry(entry);
		return entry.id;
	}

	findDispatchInput(dispatchId: string): MessageEntry | undefined {
		return this.getActivePath().find(
			(entry): entry is MessageEntry =>
				entry.type === 'message' && entry.dispatch?.dispatchId === dispatchId,
		);
	}

	findDirectSubmissionInput(submissionId: string): MessageEntry | undefined {
		return this.getActivePath().find(
			(entry): entry is MessageEntry =>
				entry.type === 'message' && entry.directSubmissionId === submissionId,
		);
	}

	findSubmissionTerminal(submissionId: string): MessageEntry | undefined {
		return this.getActivePath().find(
			(entry): entry is MessageEntry =>
				entry.type === 'message' && entry.submissionTerminal?.submissionId === submissionId,
		);
	}

	prepareImagePrompt(text: string, images: readonly PromptImage[] | undefined): string {
		if (!images || images.length === 0) return text;
		const manifest = images
			.map((image) => {
				const id = this.getOrCreateImageAttachmentId(image);
				return `<image id="${escapeXmlAttribute(id)}" mimeType="${escapeXmlAttribute(image.mimeType)}" />`;
			})
			.join('\n');
		return `${text}\n\n<attachments>\n${manifest}\n</attachments>`;
	}

	resolveImageAttachments(ids: readonly string[]): ResolvedImageAttachment[] {
		const available = new Map<string, PromptImage>();
		for (const contextEntry of this.buildContextEntries()) {
			const entry = contextEntry.entry;
			if (entry?.type !== 'message' || !entry.attachments) continue;
			const content = getImageContent(entry.message);
			for (const attachment of entry.attachments) {
				const image = content?.[attachment.contentIndex];
				if (isPromptImage(image) && image.mimeType === attachment.mimeType) {
					available.set(attachment.id, image);
				}
			}
		}
		return ids.map((id) => {
			const image = available.get(id);
			if (!image) throw new AttachmentNotAvailableError({ attachmentId: id });
			return { id, image };
		});
	}

	appendMessages(messages: AgentMessage[]): string[] {
		return messages.map((message) => this.appendMessage(message));
	}

	appendCompaction(input: CompactionAppendInput): string {
		if (!this.byId.has(input.firstKeptEntryId)) {
			throw new Error(`[flue] Cannot compact: entry "${input.firstKeptEntryId}" does not exist.`);
		}
		const entry: CompactionEntry = {
			type: 'compaction',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary: input.summary,
			firstKeptEntryId: input.firstKeptEntryId,
			tokensBefore: input.tokensBefore,
			details: input.details,
			usage: input.usage,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	toData(
		affinityKey: string,
		taskSessions: TaskSessionRef[],
		metadata: Record<string, any>,
		createdAt: string,
		updatedAt: string,
	): SessionData {
		return {
			version: 6,
			affinityKey,
			entries: [...this.entries],
			leafId: this.leafId,
			taskSessions: [...taskSessions],
			metadata,
			createdAt,
			updatedAt,
		};
	}

	/**
	 * Rewind the active path to a specific entry. Used during interrupted-tool
	 * repair to branch from the assistant message when partial out-of-order
	 * results need to be replaced with a correctly ordered complete batch.
	 */
	setLeaf(entryId: string): void {
		if (!this.byId.has(entryId)) {
			throw new Error(`[flue] Cannot set leaf: entry "${entryId}" does not exist.`);
		}
		this.leafId = entryId;
	}

	private createAttachmentRefs(message: AgentMessage): NonNullable<MessageEntry['attachments']> {
		const content = getImageContent(message);
		if (!content) return [];
		return content.flatMap((block, contentIndex) => {
			if (!isPromptImage(block)) return [];
			return [
				{
					id: this.getOrCreateImageAttachmentId(block),
					type: 'image' as const,
					mimeType: block.mimeType,
					contentIndex,
				},
			];
		});
	}

	private getOrCreateImageAttachmentId(image: PromptImage): string {
		const existing = this.imageAttachmentIds.get(image.mimeType)?.get(image.data);
		if (existing) return existing;
		const id = `att_${crypto.randomUUID()}`;
		this.rememberImageAttachment(image, id);
		return id;
	}

	private rememberImageAttachment(image: PromptImage, id: string): void {
		let byData = this.imageAttachmentIds.get(image.mimeType);
		if (!byData) {
			byData = new Map();
			this.imageAttachmentIds.set(image.mimeType, byData);
		}
		byData.set(image.data, id);
	}

	private appendEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}
}

function pathToContextEntries(path: SessionEntry[]): ContextEntry[] {
	const context: ContextEntry[] = [];
	let index = 0;
	while (index < path.length) {
		const entry = path[index];
		if (entry?.type === 'message') {
			if (entry.message.role === 'signal') {
				context.push({
					message: createUserContextMessage(renderSignalMessage(entry.message), entry.timestamp),
					entry,
				});
				index += 1;
				continue;
			}
			if (entry.message.role === 'assistant') {
				if (entry.message.stopReason === 'error' || entry.message.stopReason === 'aborted') {
					const nextEntry = path[index + 1];
					const nextNextEntry = path[index + 2];
					const isResumablePartial =
						entry.message.stopReason === 'aborted' &&
						nextEntry?.type === 'message' &&
						nextEntry.message.role === 'signal' &&
						nextEntry.message.type === 'stream_interrupted' &&
						nextNextEntry?.type === 'message' &&
						nextNextEntry.message.role === 'signal' &&
						nextNextEntry.message.type === 'stream_continued';
					if (!isResumablePartial) {
						index += 1;
						continue;
					}
				}
				const toolCalls = entry.message.content.filter((content) => content.type === 'toolCall');
				if (toolCalls.length > 0) {
					const resultEntries: MessageEntry[] = [];
					let resultIndex = index + 1;
					while (resultIndex < path.length) {
						const resultEntry = path[resultIndex];
						if (resultEntry?.type !== 'message' || resultEntry.message.role !== 'toolResult') break;
						resultEntries.push(resultEntry);
						resultIndex += 1;
					}
					if (isCompleteToolResultBatch(toolCalls, resultEntries)) {
						context.push({ message: entry.message, entry });
						for (const resultEntry of resultEntries) {
							context.push({ message: resultEntry.message, entry: resultEntry });
						}
					}
					index = resultIndex;
					continue;
				}
				context.push({ message: entry.message, entry });
				index += 1;
				continue;
			}
			if (entry.message.role !== 'toolResult') {
				context.push({ message: entry.message, entry });
			}
		}
		index += 1;
	}
	return context;
}

function getImageContent(message: AgentMessage): unknown[] | undefined {
	if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content)) {
		return undefined;
	}
	return message.content;
}

function isPromptImage(value: unknown): value is PromptImage {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
	return (
		block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
	);
}

function isCompleteToolResultBatch(
	toolCalls: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>[],
	resultEntries: MessageEntry[],
): boolean {
	if (toolCalls.length !== resultEntries.length) return false;
	const seenToolCallIds = new Set<string>();
	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const result = resultEntries[index]?.message;
		if (!toolCall || !result || result.role !== 'toolResult') return false;
		if (seenToolCallIds.has(toolCall.id)) return false;
		seenToolCallIds.add(toolCall.id);
		if (result.toolCallId !== toolCall.id || result.toolName !== toolCall.name) return false;
	}
	return true;
}

function findLatestCompactionIndex(path: SessionEntry[]): number {
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i]?.type === 'compaction') return i;
	}
	return -1;
}

function createContextSummaryMessage(summary: string, timestamp: string): AgentMessage {
	const signal: SignalMessage = {
		role: 'signal',
		type: 'context_summary',
		tagName: 'compaction',
		content: summary,
		timestamp: new Date(timestamp).getTime(),
	};
	return createUserContextMessage(renderSignalMessage(signal), timestamp);
}

export function createUserContextMessage(
	text: string,
	timestamp: string,
	images: PromptImage[] = [],
): AgentMessage {
	return {
		role: 'user',
		content: [{ type: 'text', text }, ...images],
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

export function renderSignalMessage(message: SignalMessage): string {
	const tagName = message.tagName ?? 'signal';
	const attributes = [['type', message.type], ...Object.entries(message.attributes ?? {})]
		.map(
			([name, value]) => ` ${escapeXmlAttribute(name ?? '')}="${escapeXmlAttribute(value ?? '')}"`,
		)
		.join('');
	return `<${tagName}${attributes}>\n${escapeXmlText(message.content)}\n</${tagName}>`;
}

function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replaceAll('"', '&quot;');
}

function generateEntryId(byId: Map<string, SessionEntry>): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return crypto.randomUUID();
}
