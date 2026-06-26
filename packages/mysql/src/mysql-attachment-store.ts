import {
	AttachmentConflictError,
	type AttachmentOwner,
	type AttachmentRef,
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
} from '@flue/runtime/adapter';
import type { MysqlQuery, MysqlRunner } from './mysql-adapter.ts';

interface AttachmentRecord extends StoredAttachment { owner: AttachmentOwner }

export class MysqlAttachmentStore implements AttachmentStore {
	constructor(private runner: MysqlRunner) {}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		await this.runner.transaction(async (tx) => {
			const existing = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (existing) {
				if (!sameAttachmentRef(existing.attachment, input.attachment) || !sameAttachmentOwner(existing.owner, input.owner) || !attachmentBytesEqual(existing.bytes, input.bytes)) conflict(input);
				return;
			}
			const owner = input.owner.kind === 'conversation' ? input.owner.conversationId : input.owner.submissionId;
			await tx.query(`INSERT INTO flue_attachments (stream_path, attachment_id, mime_type, byte_size, digest, owner_kind, owner_id, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size, input.attachment.digest, input.owner.kind, owner, copyAttachmentBytes(input.bytes), Date.now()]);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await readAttachment(this.runner.query, input.streamPath, input.attachmentId, false);
		if (!record || record.owner.kind !== 'conversation' || record.owner.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async listForConversation(input: { streamPath: string; conversationId: string }): Promise<AttachmentRef[]> {
		return (await this.runner.query(`SELECT attachment_id, mime_type, byte_size, digest FROM flue_attachments WHERE stream_path = ? AND owner_kind = 'conversation' AND owner_id = ? ORDER BY attachment_id`, [input.streamPath, input.conversationId])).map((row) => ({ id: String(row.attachment_id), mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) }));
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_attachments WHERE stream_path = ?', [streamPath]);
	}

	async bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void> {
		await this.runner.transaction(async (tx) => {
			const record = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!record) conflict(input);
			await verifyAttachmentBytes(input.attachment, record.bytes);
			if (!sameAttachmentRef(record.attachment, input.attachment)) conflict(input);
			if (record.owner.kind === 'conversation' && record.owner.conversationId === input.conversationId) return;
			if (record.owner.kind !== 'submission' || record.owner.submissionId !== input.submissionId) conflict(input);
			await tx.query(`UPDATE flue_attachments SET owner_kind = 'conversation', owner_id = ? WHERE stream_path = ? AND attachment_id = ?`, [input.conversationId, input.streamPath, input.attachment.id]);
		});
	}
}

async function readAttachment(query: MysqlQuery, path: string, id: string, lock: boolean): Promise<AttachmentRecord | null> {
	const row = (await query(`SELECT mime_type, byte_size, digest, owner_kind, owner_id, bytes FROM flue_attachments WHERE stream_path = ? AND attachment_id = ?${lock ? ' FOR UPDATE' : ''}`, [path, id]))[0];
	if (!row) return null;
	const bytes = row.bytes instanceof Uint8Array ? copyAttachmentBytes(row.bytes) : row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes.slice(0)) : (() => { throw new TypeError('Persisted attachment bytes are not binary data.'); })();
	return { attachment: { id, mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) }, bytes, owner: row.owner_kind === 'conversation' ? { kind: 'conversation', conversationId: String(row.owner_id) } : { kind: 'submission', submissionId: String(row.owner_id) } };
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
