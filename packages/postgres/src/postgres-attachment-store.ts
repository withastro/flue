import {
	AttachmentConflictError,
	type AttachmentRef,
	type AttachmentStore,
	attachmentBytesEqual,
	copyAttachmentBytes,
	type GetAttachmentInput,
	type PutAttachmentInput,
	type StoredAttachment,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from '@flue/runtime/adapter';
import type { PostgresQuery, PostgresRunner } from './postgres-adapter.ts';

interface AttachmentRecord extends StoredAttachment {
	conversationId: string;
}

export class PgAttachmentStore implements AttachmentStore {
	constructor(private runner: PostgresRunner) {}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		await this.runner.transaction(async (tx) => {
			const existing = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (existing) {
				if (!matchesInput(existing, input)) conflict(input);
				return;
			}
			await tx.query(
				`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, bytes, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 ON CONFLICT (stream_path, attachment_id) DO NOTHING`,
				[input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size,
					input.attachment.digest, input.conversationId, copyAttachmentBytes(input.bytes), Date.now()],
			);
			const accepted = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!accepted || !matchesInput(accepted, input)) conflict(input);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await readAttachment(this.runner.query, input.streamPath, input.attachmentId, false);
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_attachments WHERE stream_path = $1', [streamPath]);
	}
}

async function readAttachment(
	query: PostgresQuery,
	path: string,
	attachmentId: string,
	lock: boolean,
): Promise<AttachmentRecord | null> {
	const rows = await query(
		`SELECT mime_type, byte_size, digest, conversation_id, bytes
		 FROM flue_attachments WHERE stream_path = $1 AND attachment_id = $2${lock ? ' FOR UPDATE' : ''}`,
		[path, attachmentId],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		attachment: { id: attachmentId, mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) },
		bytes: binary(row.bytes),
		conversationId: String(row.conversation_id),
	};
}

function binary(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError('Persisted attachment bytes are not binary data.');
}

function matchesInput(record: AttachmentRecord, input: PutAttachmentInput): boolean {
	return sameAttachmentRef(record.attachment, input.attachment) &&
		record.conversationId === input.conversationId && attachmentBytesEqual(record.bytes, input.bytes);
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
