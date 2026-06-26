import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import { createAttachmentRef } from '../runtime/attachment-store.ts';
import { AttachmentConflictError, AttachmentIntegrityError } from '../errors.ts';

export interface AttachmentStoreContractBackend {
	create(): AttachmentStore | Promise<AttachmentStore>;
	cleanup?(): void | Promise<void>;
}

export function defineAttachmentStoreContractTests(
	label: string,
	backend: AttachmentStoreContractBackend,
): void {
	describe(label, () => {
		afterEach(async () => {
			await backend.cleanup?.();
		});

		it('returns the original bytes when an exact conversation attachment is put', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([0, 1, 2, 255]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });

			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			});

			await expect(store.get({
				streamPath: 'agents/assistant/agent-1',
				conversationId: 'conversation-1',
				attachmentId: attachment.id,
			})).resolves.toEqual({ attachment, bytes });
		});

		it('accepts an exact retry when the first put acknowledgement is uncertain', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([3, 4, 5]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/jpeg', bytes });
			const input = {
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'submission' as const, submissionId: 'submission-1' },
			};

			await store.put(input);
			await expect(store.put(input)).resolves.toBeUndefined();
		});

		it('throws AttachmentConflictError when one ID is reused with different bytes', async () => {
			const store = await backend.create();
			const first = Uint8Array.from([1]);
			const second = Uint8Array.from([2]);
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment: await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes: first }),
				bytes: first,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			});

			await expect(store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment: await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes: second }),
				bytes: second,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			})).rejects.toBeInstanceOf(AttachmentConflictError);
		});

		it('throws AttachmentConflictError when one ID is reused with a different owner', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			});

			await expect(store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-2' },
			})).rejects.toBeInstanceOf(AttachmentConflictError);
		});

		it('throws AttachmentIntegrityError when declared size differs from decoded bytes', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1, 2]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });

			await expect(store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment: { ...attachment, size: attachment.size + 1 },
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			})).rejects.toBeInstanceOf(AttachmentIntegrityError);
		});

		it('throws AttachmentIntegrityError when declared digest differs from decoded bytes', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1, 2]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });

			await expect(store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment: { ...attachment, digest: '0'.repeat(64) },
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			})).rejects.toBeInstanceOf(AttachmentIntegrityError);
		});

		it('returns null when a different conversation requests an existing attachment', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			});

			await expect(store.get({
				streamPath: 'agents/assistant/agent-1',
				conversationId: 'conversation-2',
				attachmentId: attachment.id,
			})).resolves.toBeNull();
		});

		it('binds a staged attachment when submission ownership and reference are exact', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([8, 9]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'submission', submissionId: 'submission-1' },
			});

			await store.bindSubmissionAttachment({
				streamPath: 'agents/assistant/agent-1',
				submissionId: 'submission-1',
				conversationId: 'conversation-1',
				attachment,
			});
			await expect(store.get({
				streamPath: 'agents/assistant/agent-1',
				conversationId: 'conversation-1',
				attachmentId: attachment.id,
			})).resolves.toEqual({ attachment, bytes });
			await expect(store.bindSubmissionAttachment({
				streamPath: 'agents/assistant/agent-1',
				submissionId: 'submission-1',
				conversationId: 'conversation-1',
				attachment,
			})).resolves.toBeUndefined();
		});

		it('rejects binding when the staged owner or expected reference differs', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([8, 9]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'submission', submissionId: 'submission-1' },
			});

			await expect(store.bindSubmissionAttachment({
				streamPath: 'agents/assistant/agent-1',
				submissionId: 'submission-2',
				conversationId: 'conversation-1',
				attachment,
			})).rejects.toBeInstanceOf(AttachmentConflictError);
			await expect(store.bindSubmissionAttachment({
				streamPath: 'agents/assistant/agent-1',
				submissionId: 'submission-1',
				conversationId: 'conversation-1',
				attachment: { ...attachment, mimeType: 'image/jpeg' },
			})).rejects.toBeInstanceOf(AttachmentConflictError);
		});

		it('lists only one conversation attachments', async () => {
			const store = await backend.create();
			const firstBytes = Uint8Array.from([1]);
			const secondBytes = Uint8Array.from([2]);
			const first = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes: firstBytes });
			const second = await createAttachmentRef({ id: 'attachment-2', mimeType: 'image/png', bytes: secondBytes });
			await store.put({ streamPath: 'agents/assistant/agent-1', attachment: first, bytes: firstBytes, owner: { kind: 'conversation', conversationId: 'conversation-1' } });
			await store.put({ streamPath: 'agents/assistant/agent-1', attachment: second, bytes: secondBytes, owner: { kind: 'conversation', conversationId: 'conversation-2' } });

			await expect(store.listForConversation({ streamPath: 'agents/assistant/agent-1', conversationId: 'conversation-1' })).resolves.toEqual([first]);
		});

		it('deletes every attachment when an instance is erased', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({ streamPath: 'agents/assistant/agent-1', attachment, bytes, owner: { kind: 'conversation', conversationId: 'conversation-1' } });
			await store.deleteForInstance('agents/assistant/agent-1');
			await expect(store.get({ streamPath: 'agents/assistant/agent-1', conversationId: 'conversation-1', attachmentId: attachment.id })).resolves.toBeNull();
		});

		it('returns an independent byte copy when stored or returned arrays are mutated', async () => {
			const store = await backend.create();
			const bytes = Uint8Array.from([1, 2, 3]);
			const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
			await store.put({
				streamPath: 'agents/assistant/agent-1',
				attachment,
				bytes,
				owner: { kind: 'conversation', conversationId: 'conversation-1' },
			});
			bytes[0] = 9;
			const first = await store.get({
				streamPath: 'agents/assistant/agent-1',
				conversationId: 'conversation-1',
				attachmentId: attachment.id,
			});
			if (!first) throw new Error('Expected attachment.');
			first.bytes[1] = 9;

			await expect(store.get({
				streamPath: 'agents/assistant/agent-1',
				conversationId: 'conversation-1',
				attachmentId: attachment.id,
			})).resolves.toEqual({ attachment, bytes: Uint8Array.from([1, 2, 3]) });
		});
	});
}
