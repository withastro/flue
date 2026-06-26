import type { AttachmentRef } from './conversation-records.ts';
import { AttachmentConflictError, AttachmentIntegrityError } from './errors.ts';
import {
	type AttachmentOwner,
	type AttachmentStore,
	attachmentBytesEqual,
	type BindSubmissionAttachmentInput,
	copyAttachmentBytes,
	type GetAttachmentInput,
	type PutAttachmentInput,
	type StoredAttachment,
	sameAttachmentOwner,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from './runtime/attachment-store.ts';
import type { SqlStorage } from './sql-storage.ts';

export const ATTACHMENT_CHUNK_BYTE_LENGTH = 256 * 1024;

interface SqlAttachmentRow {
	mime_type: unknown;
	byte_size: unknown;
	digest: unknown;
	owner_kind: unknown;
	owner_id: unknown;
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
			owner_kind TEXT NOT NULL CHECK (owner_kind IN ('conversation', 'submission')),
			owner_id TEXT NOT NULL,
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
		`CREATE INDEX IF NOT EXISTS flue_attachments_owner_idx
		 ON flue_attachments (stream_path, owner_kind, owner_id, attachment_id)`,
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
			const owner = ownerColumns(input.owner);
			const chunks = splitAttachmentBytes(input.bytes);
			this.sql.exec(
				`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, owner_kind, owner_id, chunk_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.streamPath,
				input.attachment.id,
				input.attachment.mimeType,
				input.attachment.size,
				input.attachment.digest,
				owner.kind,
				owner.id,
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
		if (!row || row.owner.kind !== 'conversation' || row.owner.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(row.attachment, row.bytes);
		return { attachment: { ...row.attachment }, bytes: copyAttachmentBytes(row.bytes) };
	}

	async listForConversation(input: { streamPath: string; conversationId: string }): Promise<AttachmentRef[]> {
		return this.sql.exec(
			`SELECT attachment_id, mime_type, byte_size, digest FROM flue_attachments
			 WHERE stream_path = ? AND owner_kind = 'conversation' AND owner_id = ? ORDER BY attachment_id`,
			input.streamPath,
			input.conversationId,
		).toArray().map((row) => ({ id: String(row.attachment_id), mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) }));
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		this.runTransaction(() => {
			this.sql.exec('DELETE FROM flue_attachment_chunks WHERE stream_path = ?', streamPath);
			this.sql.exec('DELETE FROM flue_attachments WHERE stream_path = ?', streamPath);
		});
	}

	async bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void> {
		const row = this.read(input.streamPath, input.attachment.id);
		if (!row) this.conflict(input.streamPath, input.attachment.id);
		await verifyAttachmentBytes(input.attachment, row.bytes);
		if (!sameAttachmentRef(row.attachment, input.attachment)) {
			this.conflict(input.streamPath, input.attachment.id);
		}
		this.runTransaction(() => {
			const current = this.read(input.streamPath, input.attachment.id);
			if (!current || !sameAttachmentRef(current.attachment, input.attachment)) {
				this.conflict(input.streamPath, input.attachment.id);
			}
			if (current.owner.kind === 'conversation' && current.owner.conversationId === input.conversationId) return;
			if (current.owner.kind !== 'submission' || current.owner.submissionId !== input.submissionId) {
				this.conflict(input.streamPath, input.attachment.id);
			}
			this.sql.exec(
				`UPDATE flue_attachments SET owner_kind = 'conversation', owner_id = ?
				 WHERE stream_path = ? AND attachment_id = ? AND owner_kind = 'submission' AND owner_id = ?`,
				input.conversationId,
				input.streamPath,
				input.attachment.id,
				input.submissionId,
			);
		});
	}

	private read(
		streamPath: string,
		attachmentId: string,
	): (StoredAttachment & { owner: AttachmentOwner }) | null {
		const value = this.sql
			.exec(
				`SELECT mime_type, byte_size, digest, owner_kind, owner_id, chunk_count
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
			owner: value.owner_kind === 'conversation'
				? { kind: 'conversation', conversationId: String(value.owner_id) }
				: { kind: 'submission', submissionId: String(value.owner_id) },
		};
	}

	private conflict(path: string, attachmentId: string): never {
		throw new AttachmentConflictError({ path, attachmentId });
	}
}

function matchesInput(
	existing: StoredAttachment & { owner: AttachmentOwner },
	input: PutAttachmentInput,
): boolean {
	return sameAttachmentRef(existing.attachment, input.attachment) &&
		sameAttachmentOwner(existing.owner, input.owner) &&
		attachmentBytesEqual(existing.bytes, input.bytes);
}

function ownerColumns(owner: AttachmentOwner): { kind: AttachmentOwner['kind']; id: string } {
	return owner.kind === 'conversation'
		? { kind: owner.kind, id: owner.conversationId }
		: { kind: owner.kind, id: owner.submissionId };
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
