import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { UserMessage } from '@mariozechner/pi-ai';
import type {
	BranchSummaryEntry,
	CompactionEntry,
	MessageEntry,
	PromptUsage,
	SessionData,
	SessionEntry,
} from './types.ts';

export type MessageSource = MessageEntry['source'];

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

export class SessionHistory {
	private entries: SessionEntry[];
	private byId: Map<string, SessionEntry>;
	private leafId: string | null;

	private constructor(entries: SessionEntry[], leafId: string | null) {
		this.entries = [...entries];
		this.leafId = leafId;
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
	}

	static empty(): SessionHistory {
		return new SessionHistory([], null);
	}

	static fromData(data: SessionData | null): SessionHistory {
		if (!data) return SessionHistory.empty();
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
			{ message: createContextSummaryMessage(compaction.summary, compaction.timestamp), entry: compaction },
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
			const entry = path[i]!;
			if (entry.type === 'compaction') return entry;
		}
		return undefined;
	}

	appendMessage(message: AgentMessage, source?: MessageSource): string {
		const entry: MessageEntry = {
			type: 'message',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			source,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	appendMessages(messages: AgentMessage[], source?: MessageSource): string[] {
		return messages.map((message) => this.appendMessage(message, source));
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

	appendBranchSummary(summary: string, fromId: string, details?: unknown): string {
		const entry: BranchSummaryEntry = {
			type: 'branch_summary',
			id: generateEntryId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
		};
		this.appendEntry(entry);
		return entry.id;
	}

	removeLeafMessage(message: AgentMessage): boolean {
		if (!this.leafId) return false;
		const leaf = this.byId.get(this.leafId);
		if (!leaf || leaf.type !== 'message' || leaf.message !== message) return false;
		this.byId.delete(leaf.id);
		this.entries = this.entries.filter((entry) => entry.id !== leaf.id);
		this.leafId = leaf.parentId;
		return true;
	}

	toData(metadata: Record<string, any>, createdAt: string, updatedAt: string): SessionData {
		return {
			version: 2,
			entries: [...this.entries],
			leafId: this.leafId,
			metadata,
			createdAt,
			updatedAt,
		};
	}

	private appendEntry(entry: SessionEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}
}

function pathToContextEntries(path: SessionEntry[]): ContextEntry[] {
	const context: ContextEntry[] = [];
	for (const entry of path) {
		if (entry.type === 'message') {
			context.push({ message: entry.message, entry });
		} else if (entry.type === 'branch_summary') {
			context.push({ message: createUserContextMessage(`[Branch Summary]\n\n${entry.summary}`, entry.timestamp), entry });
		}
	}
	return context;
}

function findLatestCompactionIndex(path: SessionEntry[]): number {
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i]!.type === 'compaction') return i;
	}
	return -1;
}

function createContextSummaryMessage(summary: string, timestamp: string): AgentMessage {
	const text = summary.startsWith('[Context Summary]') ? summary : `[Context Summary]\n\n${summary}`;
	return createUserContextMessage(text, timestamp);
}

function createUserContextMessage(text: string, timestamp: string): AgentMessage {
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

function generateEntryId(byId: Map<string, SessionEntry>): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return crypto.randomUUID();
}
