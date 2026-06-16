import type {
	PersistedChunkOwner,
	PersistedChunkRow,
	PersistedChunkStore,
} from './persisted-image-placement.ts';
import type { PersistedImageChunk } from './persisted-images.ts';
import type { SqlStorage } from './sql-storage.ts';

export function ensureSqlPersistedChunkTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_image_chunks (
		 owner_kind TEXT NOT NULL,
		 owner_id TEXT NOT NULL,
		 owner_part TEXT NOT NULL,
		 image_id TEXT NOT NULL,
		 chunk_index INTEGER NOT NULL,
		 chunk_count INTEGER NOT NULL,
		 data TEXT NOT NULL,
		 PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index)
		)`,
	);
}

export function createSqlPersistedChunkStore(sql: SqlStorage): PersistedChunkStore {
	return {
		read(owner) {
			return sql
				.exec(
					`SELECT image_id, chunk_index, chunk_count, data
					 FROM flue_image_chunks
					 WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?
					 ORDER BY image_id, chunk_index`,
					owner.kind,
					owner.id,
					owner.part,
				)
				.toArray()
				.map(parseChunkRow);
		},
		replace(owner, chunks) {
			deleteOwner(sql, owner);
			insertChunks(sql, owner, chunks);
		},
		delete(owner) {
			deleteOwner(sql, owner);
		},
		deleteMany(owners) {
			for (const owner of owners) deleteOwner(sql, owner);
		},
		deleteOwner(kind, id) {
			sql.exec('DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ?', kind, id);
		},
	};
}

function parseChunkRow(row: Record<string, unknown>): PersistedChunkRow {
	if (
		typeof row.image_id !== 'string' ||
		typeof row.chunk_index !== 'number' ||
		!Number.isInteger(row.chunk_index) ||
		typeof row.chunk_count !== 'number' ||
		!Number.isInteger(row.chunk_count) ||
		typeof row.data !== 'string'
	) {
		throw new Error('[flue] Persisted image chunk row is malformed.');
	}
	return {
		imageId: row.image_id,
		index: row.chunk_index,
		count: row.chunk_count,
		data: row.data,
	};
}

function deleteOwner(sql: SqlStorage, owner: PersistedChunkOwner): void {
	sql.exec(
		'DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?',
		owner.kind,
		owner.id,
		owner.part,
	);
}

function insertChunks(
	sql: SqlStorage,
	owner: PersistedChunkOwner,
	chunks: readonly PersistedImageChunk[],
): void {
	for (const chunk of chunks) {
		sql.exec(
			`INSERT INTO flue_image_chunks
			 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			owner.kind,
			owner.id,
			owner.part,
			chunk.imageId,
			chunk.index,
			chunk.count,
			chunk.data,
		);
	}
}
