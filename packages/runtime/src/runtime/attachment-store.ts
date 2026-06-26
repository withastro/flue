import type { AttachmentRef } from '../conversation-records.ts';
import { AttachmentConflictError, AttachmentIntegrityError } from '../errors.ts';

export type AttachmentOwner =
	| { kind: 'conversation'; conversationId: string }
	| { kind: 'submission'; submissionId: string };

export interface PutAttachmentInput {
	streamPath: string;
	attachment: AttachmentRef;
	bytes: Uint8Array;
	owner: AttachmentOwner;
}

export interface GetAttachmentInput {
	streamPath: string;
	conversationId: string;
	attachmentId: string;
}

export interface BindSubmissionAttachmentInput {
	streamPath: string;
	submissionId: string;
	conversationId: string;
	attachment: AttachmentRef;
}

export interface StoredAttachment {
	attachment: AttachmentRef;
	bytes: Uint8Array;
}

export interface AttachmentStore {
	put(input: PutAttachmentInput): Promise<void>;
	get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
	bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void>;
	listForConversation(input: { streamPath: string; conversationId: string }): Promise<AttachmentRef[]>;
	deleteForInstance(streamPath: string): Promise<void>;
}

interface InMemoryAttachmentRecord extends StoredAttachment {
	streamPath: string;
	owner: AttachmentOwner;
}

export class InMemoryAttachmentStore implements AttachmentStore {
	private records = new Map<string, InMemoryAttachmentRecord>();

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const key = attachmentKey(input.streamPath, input.attachment.id);
		const existing = this.records.get(key);
		if (existing) {
			if (
				!sameAttachmentRef(existing.attachment, input.attachment) ||
				!sameAttachmentOwner(existing.owner, input.owner) ||
				!attachmentBytesEqual(existing.bytes, input.bytes)
			) {
				throw new AttachmentConflictError({
					path: input.streamPath,
					attachmentId: input.attachment.id,
				});
			}
			return;
		}
		this.records.set(key, {
			streamPath: input.streamPath,
			attachment: { ...input.attachment },
			bytes: copyAttachmentBytes(input.bytes),
			owner: { ...input.owner },
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = this.records.get(attachmentKey(input.streamPath, input.attachmentId));
		if (!record || record.owner.kind !== 'conversation' || record.owner.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return {
			attachment: { ...record.attachment },
			bytes: copyAttachmentBytes(record.bytes),
		};
	}

	async listForConversation(input: { streamPath: string; conversationId: string }): Promise<AttachmentRef[]> {
		return [...this.records.values()].flatMap((record) =>
			record.streamPath === input.streamPath &&
			record.owner.kind === 'conversation' && record.owner.conversationId === input.conversationId
				? [{ ...record.attachment }]
				: [],
		);
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		for (const [key, record] of this.records) {
			if (record.streamPath === streamPath) this.records.delete(key);
		}
	}

	async bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void> {
		const key = attachmentKey(input.streamPath, input.attachment.id);
		const record = this.records.get(key);
		if (!record) {
			throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
		}
		await verifyAttachmentBytes(input.attachment, record.bytes);
		if (!sameAttachmentRef(record.attachment, input.attachment)) {
			throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
		}
		if (record.owner.kind === 'conversation' && record.owner.conversationId === input.conversationId) return;
		if (record.owner.kind !== 'submission' || record.owner.submissionId !== input.submissionId) {
			throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
		}
		record.owner = { kind: 'conversation', conversationId: input.conversationId };
	}
}

export async function createAttachmentRef(input: {
	id: string;
	mimeType: string;
	bytes: Uint8Array;
}): Promise<AttachmentRef> {
	return {
		id: input.id,
		mimeType: input.mimeType,
		size: input.bytes.byteLength,
		digest: await attachmentDigest(input.bytes),
	};
}

export async function verifyAttachmentBytes(
	attachment: AttachmentRef,
	bytes: Uint8Array,
): Promise<void> {
	if (attachment.size !== bytes.byteLength) {
		throw new AttachmentIntegrityError({ attachmentId: attachment.id, reason: 'size' });
	}
	if (attachment.digest !== (await attachmentDigest(bytes))) {
		throw new AttachmentIntegrityError({ attachmentId: attachment.id, reason: 'digest' });
	}
}

export function copyAttachmentBytes(bytes: Uint8Array): Uint8Array {
	return Uint8Array.from(bytes);
}

export function attachmentBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function sameAttachmentRef(left: AttachmentRef, right: AttachmentRef): boolean {
	return left.id === right.id &&
		left.mimeType === right.mimeType &&
		left.size === right.size &&
		left.digest === right.digest;
}

export function sameAttachmentOwner(left: AttachmentOwner, right: AttachmentOwner): boolean {
	return left.kind === right.kind &&
		(left.kind === 'conversation'
			? left.conversationId === (right as Extract<AttachmentOwner, { kind: 'conversation' }>).conversationId
			: left.submissionId === (right as Extract<AttachmentOwner, { kind: 'submission' }>).submissionId);
}

async function attachmentDigest(bytes: Uint8Array): Promise<string> {
	const source = Uint8Array.from(bytes);
	const digest = await crypto.subtle.digest('SHA-256', source.buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function attachmentKey(path: string, attachmentId: string): string {
	return JSON.stringify([path, attachmentId]);
}
