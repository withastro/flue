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
import type { MysqlQuery, MysqlRunner } from './mysql-adapter.ts';
import { assertMysqlConversationStreamPath } from './mysql-conversation-store.ts';

interface AttachmentRecord extends StoredAttachment { conversationId: string }

export class MysqlAttachmentStore implements AttachmentStore {
	constructor(private runner: MysqlRunner) {}

	async put(input: PutAttachmentInput): Promise<void> {
		assertMysqlConversationStreamPath(input.streamPath, 'put_attachment');
		await verifyAttachmentBytes(input.attachment, input.bytes);
		await this.runner.transaction(async (tx) => {
			await tx.query(`INSERT INTO flue_attachments (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE attachment_id = attachment_id`, [input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size, input.attachment.digest, input.conversationId, copyAttachmentBytes(input.bytes), Date.now()]);
			const accepted = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!accepted || !sameAttachmentRef(accepted.attachment, input.attachment) || accepted.conversationId !== input.conversationId || !attachmentBytesEqual(accepted.bytes, input.bytes)) conflict(input);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		assertMysqlConversationStreamPath(input.streamPath, 'get_attachment');
		const record = await readAttachment(this.runner.query, input.streamPath, input.attachmentId, false);
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		assertMysqlConversationStreamPath(streamPath, 'delete_attachments');
		await this.runner.query('DELETE FROM flue_attachments WHERE stream_path = ?', [streamPath]);
	}
}

async function readAttachment(query: MysqlQuery, path: string, id: string, lock: boolean): Promise<AttachmentRecord | null> {
	const row = (await query(`SELECT mime_type, byte_size, digest, conversation_id, bytes FROM flue_attachments WHERE stream_path = ? AND attachment_id = ?${lock ? ' FOR UPDATE' : ''}`, [path, id]))[0];
	if (!row) return null;
	const bytes = row.bytes instanceof Uint8Array ? copyAttachmentBytes(row.bytes) : row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes.slice(0)) : (() => { throw new TypeError('Persisted attachment bytes are not binary data.'); })();
	return { attachment: { id, mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) }, bytes, conversationId: String(row.conversation_id) };
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
