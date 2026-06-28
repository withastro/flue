import type { AttachmentRef } from '../conversation-records.ts';
import { AttachmentConflictError, AttachmentIntegrityError } from '../errors.ts';

export interface PutAttachmentInput {
	streamPath: string;
	attachment: AttachmentRef;
	bytes: Uint8Array;
	conversationId: string;
}

export interface GetAttachmentInput {
	streamPath: string;
	conversationId: string;
	attachmentId: string;
}

export interface StoredAttachment {
	attachment: AttachmentRef;
	bytes: Uint8Array;
}

export interface AttachmentStore {
	put(input: PutAttachmentInput): Promise<void>;
	get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
	deleteForInstance(streamPath: string): Promise<void>;
}

interface InMemoryAttachmentRecord extends StoredAttachment {
	streamPath: string;
	conversationId: string;
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
				existing.conversationId !== input.conversationId ||
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
			conversationId: input.conversationId,
		});
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = this.records.get(attachmentKey(input.streamPath, input.attachmentId));
		if (!record || record.conversationId !== input.conversationId) {
			return null;
		}
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return {
			attachment: { ...record.attachment },
			bytes: copyAttachmentBytes(record.bytes),
		};
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		for (const [key, record] of this.records) {
			if (record.streamPath === streamPath) this.records.delete(key);
		}
	}
}

export async function createAttachmentRef(input: {
	id: string;
	mimeType: string;
	bytes: Uint8Array;
	filename?: string;
}): Promise<AttachmentRef> {
	return {
		id: input.id,
		mimeType: input.mimeType,
		size: input.bytes.byteLength,
		digest: await attachmentDigest(input.bytes),
		...(input.filename ? { filename: input.filename } : {}),
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
	// `filename` is presentation metadata, not byte identity, and is not persisted
	// by every store — so it is deliberately excluded so an idempotent re-`put`
	// (recovery) never conflicts on a filename that didn't round-trip.
	return left.id === right.id &&
		left.mimeType === right.mimeType &&
		left.size === right.size &&
		left.digest === right.digest;
}

async function attachmentDigest(bytes: Uint8Array): Promise<string> {
	const source = Uint8Array.from(bytes);
	const digest = await crypto.subtle.digest('SHA-256', source.buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function attachmentKey(path: string, attachmentId: string): string {
	return JSON.stringify([path, attachmentId]);
}
