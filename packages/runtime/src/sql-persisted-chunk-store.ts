import type { SubmissionChunkRow, SubmissionChunkStore } from './persisted-image-placement.ts';
import type { SqlStorage } from './sql-storage.ts';

export function ensureSqlSubmissionChunkTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_submission_chunks (
		 submission_id TEXT NOT NULL,
		 item_id TEXT NOT NULL,
		 chunk_index INTEGER NOT NULL,
		 chunk_count INTEGER NOT NULL,
		 data TEXT NOT NULL,
		 PRIMARY KEY (submission_id, item_id, chunk_index)
		)`,
	);
}

export function createSqlSubmissionChunkStore(sql: SqlStorage): SubmissionChunkStore {
	return {
		read(submissionId) {
			return sql
				.exec(
					`SELECT item_id, chunk_index, chunk_count, data
					 FROM flue_submission_chunks
					 WHERE submission_id = ?
					 ORDER BY item_id, chunk_index`,
					submissionId,
				)
				.toArray()
				.map(parseChunkRow);
		},
		replace(submissionId, chunks) {
			sql.exec('DELETE FROM flue_submission_chunks WHERE submission_id = ?', submissionId);
			insertChunks(sql, submissionId, chunks);
		},
	};
}

function parseChunkRow(row: Record<string, unknown>): SubmissionChunkRow {
	if (
		typeof row.item_id !== 'string' ||
		typeof row.chunk_index !== 'number' ||
		!Number.isInteger(row.chunk_index) ||
		typeof row.chunk_count !== 'number' ||
		!Number.isInteger(row.chunk_count) ||
		typeof row.data !== 'string'
	) {
		throw new Error('[flue] Persisted submission chunk row is malformed.');
	}
	return {
		itemId: row.item_id,
		index: row.chunk_index,
		count: row.chunk_count,
		data: row.data,
	};
}

function insertChunks(
	sql: SqlStorage,
	submissionId: string,
	chunks: readonly SubmissionChunkRow[],
): void {
	for (const chunk of chunks) {
		sql.exec(
			`INSERT INTO flue_submission_chunks
			 (submission_id, item_id, chunk_index, chunk_count, data)
			 VALUES (?, ?, ?, ?, ?)`,
			submissionId,
			chunk.itemId,
			chunk.index,
			chunk.count,
			chunk.data,
		);
	}
}
