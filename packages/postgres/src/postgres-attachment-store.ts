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
import type { PostgresQuery, PostgresRunner } from './postgres-adapter.ts';

interface AttachmentRecord extends StoredAttachment {
	owner: AttachmentOwner;
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
			const owner = ownerColumns(input.owner);
			await tx.query(
				`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, owner_kind, owner_id, bytes, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				 ON CONFLICT (stream_path, attachment_id) DO NOTHING`,
				[input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size,
					input.attachment.digest, owner.kind, owner.id, copyAttachmentBytes(input.bytes), Date.now()],
			);
			const accepted = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!accepted || !matchesInput(accepted, input)) conflict(input);
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await readAttachment(this.runner.query, input.streamPath, input.attachmentId, false);
		if (!record || record.owner.kind !== 'conversation' || record.owner.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async listForConversation(input: { streamPath: string; conversationId: string }): Promise<AttachmentRef[]> {
		return (await this.runner.query(`SELECT attachment_id, mime_type, byte_size, digest FROM flue_attachments WHERE stream_path = $1 AND owner_kind = 'conversation' AND owner_id = $2 ORDER BY attachment_id`, [input.streamPath, input.conversationId])).map((row) => ({ id: String(row.attachment_id), mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) }));
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_attachments WHERE stream_path = $1', [streamPath]);
	}

	async bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void> {
		await this.runner.transaction(async (tx) => {
			const record = await readAttachment(tx.query, input.streamPath, input.attachment.id, true);
			if (!record) conflict(input);
			await verifyAttachmentBytes(input.attachment, record.bytes);
			if (!sameAttachmentRef(record.attachment, input.attachment)) conflict(input);
			if (record.owner.kind === 'conversation' && record.owner.conversationId === input.conversationId) return;
			if (record.owner.kind !== 'submission' || record.owner.submissionId !== input.submissionId) conflict(input);
			await tx.query(
				`UPDATE flue_attachments SET owner_kind = 'conversation', owner_id = $1
				 WHERE stream_path = $2 AND attachment_id = $3`,
				[input.conversationId, input.streamPath, input.attachment.id],
			);
		});
	}
}

async function readAttachment(
	query: PostgresQuery,
	path: string,
	attachmentId: string,
	lock: boolean,
): Promise<AttachmentRecord | null> {
	const rows = await query(
		`SELECT mime_type, byte_size, digest, owner_kind, owner_id, bytes
		 FROM flue_attachments WHERE stream_path = $1 AND attachment_id = $2${lock ? ' FOR UPDATE' : ''}`,
		[path, attachmentId],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		attachment: { id: attachmentId, mimeType: String(row.mime_type), size: Number(row.byte_size), digest: String(row.digest) },
		bytes: binary(row.bytes),
		owner: row.owner_kind === 'conversation'
			? { kind: 'conversation', conversationId: String(row.owner_id) }
			: { kind: 'submission', submissionId: String(row.owner_id) },
	};
}

function binary(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError('Persisted attachment bytes are not binary data.');
}

function matchesInput(record: AttachmentRecord, input: PutAttachmentInput): boolean {
	return sameAttachmentRef(record.attachment, input.attachment) &&
		sameAttachmentOwner(record.owner, input.owner) && attachmentBytesEqual(record.bytes, input.bytes);
}

function ownerColumns(owner: AttachmentOwner): { kind: AttachmentOwner['kind']; id: string } {
	return owner.kind === 'conversation'
		? { kind: owner.kind, id: owner.conversationId }
		: { kind: owner.kind, id: owner.submissionId };
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
