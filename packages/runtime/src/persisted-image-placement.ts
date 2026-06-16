import {
	type ExtractedImages,
	extractDirectSubmissionImages,
	extractSessionEntryImages,
	hydrateDirectSubmissionImages,
	hydrateSessionEntryImages,
	type PersistedImageChunk,
} from './persisted-images.ts';
import type { DirectAgentSubmissionInput } from './runtime/agent-submissions.ts';
import type { SessionEntry } from './types.ts';

export interface PersistedChunkOwner {
	kind: 'session_entry' | 'submission';
	id: string;
	part: string;
}

export interface PersistedChunkRow {
	imageId: string;
	index: number;
	count: number;
	data: string;
}

export interface PersistedChunkStore<Result = void> {
	read(
		owner: PersistedChunkOwner,
	): Result extends Promise<unknown> ? Promise<PersistedChunkRow[]> : PersistedChunkRow[];
	replace(owner: PersistedChunkOwner, chunks: readonly PersistedImageChunk[]): Result;
	delete(owner: PersistedChunkOwner): Result;
	deleteMany(owners: readonly PersistedChunkOwner[]): Result;
	deleteOwner(kind: PersistedChunkOwner['kind'], id: string): Result;
}

export function sessionEntryChunkOwner(sessionId: string, entryId: string): PersistedChunkOwner {
	return { kind: 'session_entry', id: sessionId, part: entryId };
}

export function submissionChunkOwner(submissionId: string): PersistedChunkOwner {
	return { kind: 'submission', id: submissionId, part: '' };
}

export function prepareSessionEntry(entry: SessionEntry): ExtractedImages<SessionEntry> {
	return extractSessionEntryImages(entry);
}

export function prepareDirectSubmission(
	input: DirectAgentSubmissionInput,
): ExtractedImages<DirectAgentSubmissionInput> {
	return extractDirectSubmissionImages(input);
}

export function hydratePersistedSessionEntry(
	entry: SessionEntry,
	rows: readonly PersistedChunkRow[],
): SessionEntry {
	return hydrateSessionEntryImages(entry, reassemblePersistedChunks(rows));
}

export function hydratePersistedDirectSubmission(
	input: DirectAgentSubmissionInput,
	rows: readonly PersistedChunkRow[],
): DirectAgentSubmissionInput {
	return hydrateDirectSubmissionImages(input, reassemblePersistedChunks(rows));
}

export function matchesPersistedDirectSubmission(
	input: DirectAgentSubmissionInput,
	persistedInput: DirectAgentSubmissionInput,
	rows: readonly PersistedChunkRow[],
): boolean {
	try {
		return (
			JSON.stringify(hydratePersistedDirectSubmission(persistedInput, rows)) ===
			JSON.stringify(input)
		);
	} catch {
		return false;
	}
}

function reassemblePersistedChunks(
	rows: readonly PersistedChunkRow[],
): ReadonlyMap<string, string> {
	const grouped = new Map<string, PersistedChunkRow[]>();
	for (const row of rows) {
		const imageRows = grouped.get(row.imageId) ?? [];
		imageRows.push(row);
		grouped.set(row.imageId, imageRows);
	}
	const data = new Map<string, string>();
	for (const [imageId, imageRows] of grouped) {
		const ordered = imageRows.toSorted((left, right) => left.index - right.index);
		const expectedCount = ordered[0]?.count;
		if (
			expectedCount === undefined ||
			expectedCount < 1 ||
			ordered.length !== expectedCount ||
			ordered.some((row, index) => row.count !== expectedCount || row.index !== index)
		) {
			throw new Error('[flue] Persisted image chunks are missing or malformed.');
		}
		data.set(imageId, ordered.map((row) => row.data).join(''));
	}
	return data;
}

export function samePersistedChunks(
	left: readonly PersistedChunkRow[],
	right: readonly PersistedImageChunk[],
): boolean {
	if (left.length !== right.length) return false;
	const rightByKey = new Map(right.map((chunk) => [chunkKey(chunk), chunk]));
	return left.every((chunk) => {
		const other = rightByKey.get(chunkKey(chunk));
		return other !== undefined && chunk.count === other.count && chunk.data === other.data;
	});
}

function chunkKey(chunk: Pick<PersistedChunkRow, 'imageId' | 'index'>): string {
	return `${chunk.imageId}\u0000${chunk.index}`;
}
