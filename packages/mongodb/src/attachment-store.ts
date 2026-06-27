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
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';

interface AttachmentRecord extends StoredAttachment { conversationId: string }

export class MongoAttachmentStore implements AttachmentStore {
	constructor(private runner: MongoRunner, private prefix: string) {}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		try {
			await this.runner.transaction(async (tx) => {
				const collection = tx.collection(collectionName(this.prefix, 'attachments'));
				const existing = parse(await collection.findOne({ path: input.streamPath, attachmentId: input.attachment.id }), input.attachment.id);
				if (existing) {
					if (!matchesInput(existing, input)) conflict(input);
					return;
				}
				await collection.insertOne({ _id: crypto.randomUUID(), path: input.streamPath, attachmentId: input.attachment.id, mimeType: input.attachment.mimeType, byteSize: input.attachment.size, digest: input.attachment.digest, conversationId: input.conversationId, bytes: copyAttachmentBytes(input.bytes), createdAt: Date.now() });
			});
		} catch (error) {
			if (!isDuplicate(error)) throw error;
			const accepted = parse(
				await this.collection(this.runner).findOne({ path: input.streamPath, attachmentId: input.attachment.id }),
				input.attachment.id,
			);
			if (!accepted || !matchesInput(accepted, input)) conflict(input);
		}
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = parse(await this.collection(this.runner).findOne({ path: input.streamPath, attachmentId: input.attachmentId, conversationId: input.conversationId }), input.attachmentId);
		if (!record) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		await this.collection(this.runner).deleteMany({ path: streamPath });
	}

	private collection(operations: MongoOperations) {
		return operations.collection(collectionName(this.prefix, 'attachments'));
	}
}

function parse(document: Record<string, unknown> | null, id: string): AttachmentRecord | null {
	if (!document) return null;
	const bytes = document.bytes instanceof Uint8Array ? copyAttachmentBytes(document.bytes) : document.bytes instanceof ArrayBuffer ? new Uint8Array(document.bytes.slice(0)) : binaryFromBson(document.bytes);
	return { attachment: { id, mimeType: String(document.mimeType), size: Number(document.byteSize), digest: String(document.digest) }, bytes, conversationId: String(document.conversationId) };
}

function matchesInput(record: AttachmentRecord, input: PutAttachmentInput): boolean {
	return sameAttachmentRef(record.attachment, input.attachment) &&
		record.conversationId === input.conversationId &&
		attachmentBytesEqual(record.bytes, input.bytes);
}

function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}

function binaryFromBson(value: unknown): Uint8Array {
	if (value && typeof value === 'object' && 'buffer' in value) {
		const buffer = (value as { buffer: unknown }).buffer;
		if (buffer instanceof Uint8Array) return copyAttachmentBytes(buffer);
	}
	throw new TypeError('Persisted attachment bytes are not binary data.');
}

function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
