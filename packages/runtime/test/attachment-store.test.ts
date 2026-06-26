import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AttachmentIntegrityError } from '../src/errors.ts';
import { createAttachmentRef } from '../src/runtime/attachment-store.ts';
import {
	ATTACHMENT_CHUNK_BYTE_LENGTH,
	SqliteAttachmentStore,
} from '../src/sql-attachment-store.ts';
import type { SqlStorage } from '../src/sql-storage.ts';
import { defineAttachmentStoreContractTests } from '../src/test-utils/define-attachment-store-contract-tests.ts';

function createSql(db: DatabaseSync): SqlStorage {
	return {
		exec(query, ...bindings) {
			const statement = db.prepare(query);
			const returnsRows = query.trimStart().toUpperCase().startsWith('SELECT') || /\bRETURNING\b/i.test(query);
			const rows = returnsRows
				? statement.all(...(bindings as never[])) as Record<string, unknown>[]
				: (statement.run(...(bindings as never[])), []);
			return { toArray: () => rows };
		},
	};
}

function transaction(db: DatabaseSync): <T>(closure: () => T) => T {
	return (closure) => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
}

describe('SqliteAttachmentStore', () => {
	let db: DatabaseSync | undefined;
	defineAttachmentStoreContractTests('AttachmentStore contract', {
		create() {
			db = new DatabaseSync(':memory:');
			return new SqliteAttachmentStore(createSql(db), transaction(db));
		},
		cleanup() {
			db?.close();
			db = undefined;
		},
	});

	it('reassembles an attachment larger than one storage chunk', async () => {
		const db = new DatabaseSync(':memory:');
		const store = new SqliteAttachmentStore(createSql(db), transaction(db));
		const bytes = Uint8Array.from(
			{ length: ATTACHMENT_CHUNK_BYTE_LENGTH + 17 },
			(_, index) => index % 251,
		);
		const attachment = await createAttachmentRef({ id: 'attachment-large', mimeType: 'image/png', bytes });

		await store.put({
			streamPath: 'agents/assistant/agent-1',
			attachment,
			bytes,
			owner: { kind: 'conversation', conversationId: 'conversation-1' },
		});

		expect(db.prepare(
			`SELECT length(bytes) AS byte_length FROM flue_attachment_chunks
			 WHERE stream_path = ? AND attachment_id = ? ORDER BY chunk_index`,
		).all('agents/assistant/agent-1', attachment.id)).toEqual([
			{ byte_length: ATTACHMENT_CHUNK_BYTE_LENGTH },
			{ byte_length: 17 },
		]);
		await expect(store.get({
			streamPath: 'agents/assistant/agent-1',
			conversationId: 'conversation-1',
			attachmentId: attachment.id,
		})).resolves.toEqual({ attachment, bytes });
		db.close();
	});

	it('rejects an attachment when a persisted chunk is missing', async () => {
		const db = new DatabaseSync(':memory:');
		const store = new SqliteAttachmentStore(createSql(db), transaction(db));
		const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTE_LENGTH + 1);
		const attachment = await createAttachmentRef({ id: 'attachment-large', mimeType: 'image/png', bytes });
		await store.put({
			streamPath: 'agents/assistant/agent-1',
			attachment,
			bytes,
			owner: { kind: 'conversation', conversationId: 'conversation-1' },
		});
		db.prepare(
			`DELETE FROM flue_attachment_chunks
			 WHERE stream_path = ? AND attachment_id = ? AND chunk_index = 1`,
		).run('agents/assistant/agent-1', attachment.id);

		await expect(store.get({
			streamPath: 'agents/assistant/agent-1',
			conversationId: 'conversation-1',
			attachmentId: attachment.id,
		})).rejects.toBeInstanceOf(AttachmentIntegrityError);
		db.close();
	});

	it('rejects an attachment when persisted chunk cardinality is inconsistent', async () => {
		const db = new DatabaseSync(':memory:');
		const store = new SqliteAttachmentStore(createSql(db), transaction(db));
		const bytes = Uint8Array.from([1, 2, 3]);
		const attachment = await createAttachmentRef({ id: 'attachment-1', mimeType: 'image/png', bytes });
		await store.put({
			streamPath: 'agents/assistant/agent-1',
			attachment,
			bytes,
			owner: { kind: 'conversation', conversationId: 'conversation-1' },
		});
		db.prepare(
			`UPDATE flue_attachments SET chunk_count = 2
			 WHERE stream_path = ? AND attachment_id = ?`,
		).run('agents/assistant/agent-1', attachment.id);

		await expect(store.get({
			streamPath: 'agents/assistant/agent-1',
			conversationId: 'conversation-1',
			attachmentId: attachment.id,
		})).rejects.toBeInstanceOf(AttachmentIntegrityError);
		db.close();
	});
});
