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
import type { RedisKeys } from './redis-keys.ts';
import type { RedisRunner } from './redis-runner.ts';

interface AttachmentRecord extends StoredAttachment {
	conversationId: string;
}

export class RedisAttachmentStore implements AttachmentStore {
	constructor(
		private runner: RedisRunner,
		private keys: RedisKeys,
	) {}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const existing = await this.read(input.streamPath, input.attachment.id);
		if (existing) {
			if (
				!sameAttachmentRef(existing.attachment, input.attachment) ||
				existing.conversationId !== input.conversationId ||
				!attachmentBytesEqual(existing.bytes, input.bytes)
			)
				conflict(input);
			return;
		}
		const result = await this.runner.eval(
			PUT,
			[
				this.keys.attachment(input.streamPath, input.attachment.id),
				this.keys.attachments(input.streamPath),
			],
			[
				input.attachment.mimeType,
				input.attachment.size,
				input.attachment.digest,
				input.conversationId,
				encodeBytes(input.bytes),
				Date.now(),
				input.attachment.id,
			],
		);
		if (Number(result) !== 1) {
			const accepted = await this.read(input.streamPath, input.attachment.id);
			if (
				!accepted ||
				!sameAttachmentRef(accepted.attachment, input.attachment) ||
				accepted.conversationId !== input.conversationId ||
				!attachmentBytesEqual(accepted.bytes, input.bytes)
			)
				conflict(input);
		}
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await this.read(input.streamPath, input.attachmentId);
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	private async read(path: string, id: string): Promise<AttachmentRecord | null> {
		const value = await this.runner.command('HMGET', [
			this.keys.attachment(path, id),
			'mimeType',
			'byteSize',
			'digest',
			'conversationId',
			'bytes',
		]);
		if (!Array.isArray(value) || value[0] == null) return null;
		return {
			attachment: {
				id,
				mimeType: string(value[0]),
				size: Number(string(value[1])),
				digest: string(value[2]),
			},
			conversationId: string(value[3]),
			bytes: decodeBytes(string(value[4])),
		};
	}
}

const PUT = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('HSET', KEYS[1], 'mimeType', ARGV[1], 'byteSize', ARGV[2], 'digest', ARGV[3], 'conversationId', ARGV[4], 'bytes', ARGV[5], 'createdAt', ARGV[6]) redis.call('SADD',KEYS[2],ARGV[7]) return 1`;

function string(value: unknown): string {
	return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
}
// Attachment bytes cross the RedisRunner seam as base64 text so that runners
// which coerce arguments/replies through strings (the blueprint runners)
// round-trip them losslessly. Digest verification on read still catches any
// value that was corrupted at rest.
function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}
function decodeBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}
function conflict(input: { streamPath: string; attachment: AttachmentRef }): never {
	throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id });
}
