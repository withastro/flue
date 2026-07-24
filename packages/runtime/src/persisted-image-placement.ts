import {
	type ExtractedImages,
	extractSubmissionAttachments,
	hydrateSubmissionAttachments,
	type SubmissionChunkRow,
} from './persisted-images.ts';
import type { AgentSubmissionInput } from './runtime/agent-submissions.ts';

export type { SubmissionChunkRow } from './persisted-images.ts';

/**
 * Storage for submission-payload overflow chunks (`flue_submission_chunks`):
 * oversized attachment parts are split out of the persisted payload at
 * admission and reassembled on read. Chunks share the submission row's
 * lifecycle — `replace` swaps the whole chunk group atomically with respect
 * to the admission transaction the caller has opened.
 */
export interface SubmissionChunkStore<Result = void> {
	read(
		submissionId: string,
	): Result extends Promise<unknown> ? Promise<SubmissionChunkRow[]> : SubmissionChunkRow[];
	replace(submissionId: string, chunks: readonly SubmissionChunkRow[]): Result;
}

/**
 * Extract and chunk a submission's attachments (present only on a `kind:
 * 'user'` message) for oversized-row-safe storage. Applies to both direct
 * and dispatch submissions — attachments are a property of the message, not
 * the transport.
 */
export function prepareSubmissionAttachments(
	input: AgentSubmissionInput,
): ExtractedImages<AgentSubmissionInput> {
	return extractSubmissionAttachments(input);
}

export function hydratePersistedSubmissionAttachments(
	input: AgentSubmissionInput,
	rows: readonly SubmissionChunkRow[],
): AgentSubmissionInput {
	return hydrateSubmissionAttachments(input, reassemblePersistedChunks(rows));
}

export function matchesPersistedSubmissionAttachments(
	input: AgentSubmissionInput,
	persistedInput: AgentSubmissionInput,
	rows: readonly SubmissionChunkRow[],
): boolean {
	try {
		return (
			JSON.stringify(hydratePersistedSubmissionAttachments(persistedInput, rows)) ===
			JSON.stringify(input)
		);
	} catch {
		return false;
	}
}

function reassemblePersistedChunks(
	rows: readonly SubmissionChunkRow[],
): ReadonlyMap<string, string> {
	const grouped = new Map<string, SubmissionChunkRow[]>();
	for (const row of rows) {
		const itemRows = grouped.get(row.itemId) ?? [];
		itemRows.push(row);
		grouped.set(row.itemId, itemRows);
	}
	const data = new Map<string, string>();
	for (const [itemId, itemRows] of grouped) {
		const ordered = itemRows.toSorted((left, right) => left.index - right.index);
		const expectedCount = ordered[0]?.count;
		if (
			expectedCount === undefined ||
			expectedCount < 1 ||
			ordered.length !== expectedCount ||
			ordered.some((row, index) => row.count !== expectedCount || row.index !== index)
		) {
			throw new Error('[flue] Persisted image chunks are missing or malformed.');
		}
		data.set(itemId, ordered.map((row) => row.data).join(''));
	}
	return data;
}

export function sameSubmissionChunks(
	left: readonly SubmissionChunkRow[],
	right: readonly SubmissionChunkRow[],
): boolean {
	if (left.length !== right.length) return false;
	const rightByKey = new Map(right.map((chunk) => [chunkKey(chunk), chunk]));
	return left.every((chunk) => {
		const other = rightByKey.get(chunkKey(chunk));
		return other !== undefined && chunk.count === other.count && chunk.data === other.data;
	});
}

function chunkKey(chunk: Pick<SubmissionChunkRow, 'itemId' | 'index'>): string {
	return `${chunk.itemId}\u0000${chunk.index}`;
}
