import { AttachmentConflictError, AttachmentIntegrityError } from './errors.ts';
import {
	type AttachmentStore,
	attachmentBytesEqual,
	copyAttachmentBytes,
	type GetAttachmentInput,
	type PutAttachmentInput,
	type StoredAttachment,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from './runtime/attachment-store.ts';
import type { SqlStorage } from './sql-storage.ts';

export const ATTACHMENT_CHUNK_BYTE_LENGTH = 256 * 1024;

interface SqlAttachmentRow {
	mime_type: unknown;
	byte_size: unknown;
	digest: unknown;
	conversation_id: unknown;
	chunk_count: unknown;
}

interface SqlAttachmentChunkRow {
	chunk_index: unknown;
	bytes: unknown;
}

export function ensureSqlAttachmentTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_attachments (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
			digest TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
			created_at INTEGER NOT NULL,
			PRIMARY KEY (stream_path, attachment_id)
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_attachment_chunks (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
			bytes BLOB NOT NULL,
			PRIMARY KEY (stream_path, attachment_id, chunk_index),
			FOREIGN KEY (stream_path, attachment_id)
				REFERENCES flue_attachments (stream_path, attachment_id) ON DELETE CASCADE
		)`,
	);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS flue_attachments_conversation_idx
		 ON flue_attachments (stream_path, conversation_id, attachment_id)`,
	);
}

export class SqliteAttachmentStore implements AttachmentStore {
	constructor(
		private readonly sql: SqlStorage,
		private readonly runTransaction: <T>(closure: () => T) => T,
	) {
		ensureSqlAttachmentTable(sql);
	}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		this.runTransaction(() => {
			const existing = this.read(input.streamPath, input.attachment.id);
			if (existing) {
				if (!matchesInput(existing, input)) this.conflict(input.streamPath, input.attachment.id);
				return;
			}
			const chunks = splitAttachmentBytes(input.bytes);
			this.sql.exec(
				`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.streamPath,
				input.attachment.id,
				input.attachment.mimeType,
				input.attachment.size,
				input.attachment.digest,
				input.conversationId,
				chunks.length,
				Date.now(),
			);
			for (const [index, bytes] of chunks.entries()) {
				this.sql.exec(
					`INSERT INTO flue_attachment_chunks
					 (stream_path, attachment_id, chunk_index, bytes) VALUES (?, ?, ?, ?)`,
					input.streamPath,
					input.attachment.id,
					index,
					bytes,
				);
			}
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const row = this.read(input.streamPath, input.attachmentId);
		if (!row || row.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(row.attachment, row.bytes);
		return { attachment: { ...row.attachment }, bytes: copyAttachmentBytes(row.bytes) };
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		this.runTransaction(() => {
			this.sql.exec('DELETE FROM flue_attachment_chunks WHERE stream_path = ?', streamPath);
			this.sql.exec('DELETE FROM flue_attachments WHERE stream_path = ?', streamPath);
		});
	}

	private read(
		streamPath: string,
		attachmentId: string,
	): (StoredAttachment & { conversationId: string }) | null {
		const value = this.sql
			.exec(
				`SELECT mime_type, byte_size, digest, conversation_id, chunk_count
				 FROM flue_attachments WHERE stream_path = ? AND attachment_id = ?`,
				streamPath,
				attachmentId,
			)
			.toArray()[0] as SqlAttachmentRow | undefined;
		if (!value) return null;
		const chunkCount = parseChunkCount(value.chunk_count, attachmentId);
		const chunks = this.sql.exec(
			`SELECT chunk_index, bytes FROM flue_attachment_chunks
			 WHERE stream_path = ? AND attachment_id = ? ORDER BY chunk_index`,
			streamPath,
			attachmentId,
		).toArray() as unknown as SqlAttachmentChunkRow[];
		return {
			attachment: {
				id: attachmentId,
				mimeType: String(value.mime_type),
				size: Number(value.byte_size),
				digest: String(value.digest),
			},
			bytes: reassembleAttachmentBytes(attachmentId, chunkCount, chunks),
			conversationId: String(value.conversation_id),
		};
	}

	private conflict(path: string, attachmentId: string): never {
		throw new AttachmentConflictError({ path, attachmentId });
	}
}

function matchesInput(
	existing: StoredAttachment & { conversationId: string },
	input: PutAttachmentInput,
): boolean {
	return sameAttachmentRef(existing.attachment, input.attachment) &&
		existing.conversationId === input.conversationId &&
		attachmentBytesEqual(existing.bytes, input.bytes);
}

function splitAttachmentBytes(bytes: Uint8Array): Uint8Array[] {
	const count = Math.max(1, Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTE_LENGTH));
	return Array.from({ length: count }, (_, index) =>
		copyAttachmentBytes(bytes.subarray(
			index * ATTACHMENT_CHUNK_BYTE_LENGTH,
			Math.min(bytes.byteLength, (index + 1) * ATTACHMENT_CHUNK_BYTE_LENGTH),
		)),
	);
}

function parseChunkCount(value: unknown, attachmentId: string): number {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count <= 0) {
		throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
	}
	return count;
}

function reassembleAttachmentBytes(
	attachmentId: string,
	chunkCount: number,
	rows: readonly SqlAttachmentChunkRow[],
): Uint8Array {
	if (rows.length !== chunkCount) {
		throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
	}
	const chunks = rows.map((row, index) => {
		if (Number(row.chunk_index) !== index) {
			throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
		}
		const bytes = sqlBytes(row.bytes);
		if (bytes.byteLength > ATTACHMENT_CHUNK_BYTE_LENGTH || (index < chunkCount - 1 && bytes.byteLength === 0)) {
			throw new AttachmentIntegrityError({ attachmentId, reason: 'chunks' });
		}
		return bytes;
	});
	const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function sqlBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError('Persisted attachment bytes are not binary data.');
}
