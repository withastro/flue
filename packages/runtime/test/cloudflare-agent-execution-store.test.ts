import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createSqlAgentExecutionStore,
	createR2SessionAttachmentStore,
	createSqlSessionStore,
} from '../src/cloudflare/agent-execution-store.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';
import type { SessionAttachmentStore } from '../src/sql-agent-execution-store.ts';
import type { SessionData } from '../src/types.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		transactionSync<T>(closure: () => T): T {
			db.exec('BEGIN');
			try {
				const result = closure();
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				let rows: unknown[];
				const trimmed = query.trimStart().toUpperCase();
				const expectsRows =
					trimmed.startsWith('SELECT') ||
					trimmed.startsWith('WITH') ||
					/\bRETURNING\b/i.test(query);
				if (expectsRows) {
					rows = stmt.all(...(bindings as never[]));
				} else {
					stmt.run(...(bindings as never[]));
					rows = [];
				}
				return {
					toArray() {
						return rows as Record<string, unknown>[];
					},
				};
			},
		},
	};
}

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		input: { text: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId };
}

function sessionData(overrides: Partial<SessionData> = {}): SessionData {
	return {
		version: 5,
		affinityKey: 'aff_01J00000000000000000000000',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

class RecordingAttachmentStore implements SessionAttachmentStore {
	readonly objects = new Map<string, string>();
	readonly deleted: string[] = [];

	async put(key: string, data: string): Promise<void> {
		this.objects.set(key, data);
	}

	async get(key: string): Promise<string> {
		const data = this.objects.get(key);
		if (data === undefined) throw new Error(`missing object ${key}`);
		return data;
	}

	async delete(key: string): Promise<void> {
		this.deleted.push(key);
		this.objects.delete(key);
	}
}

describe('createSqlAgentExecutionStore()', () => {
	it('creates the initial flue_agent_submissions schema and ordering indexes when initialized', () => {
		const { db, sql, transactionSync } = makeFakeSql();

		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_agent_submissions') ORDER BY cid").all(),
		).toEqual([
			{ name: 'sequence' },
			{ name: 'submission_id' },
			{ name: 'session_key' },
			{ name: 'kind' },
			{ name: 'payload' },
			{ name: 'status' },
			{ name: 'accepted_at' },
			{ name: 'attempt_id' },
			{ name: 'input_applied_at' },
			{ name: 'recovery_requested_at' },
			{ name: 'started_at' },
			{ name: 'settled_at' },
			{ name: 'error' },
			{ name: 'attempt_count' },
			{ name: 'max_retry' },
			{ name: 'timeout_at' },
			{ name: 'owner_id' },
			{ name: 'lease_expires_at' },
		]);
		expect(
			db
				.prepare("SELECT name FROM pragma_table_info('flue_agent_turn_journals') ORDER BY cid")
				.all(),
		).toEqual([
			{ name: 'submission_id' },
			{ name: 'session_key' },
			{ name: 'kind' },
			{ name: 'attempt_id' },
			{ name: 'operation_id' },
			{ name: 'turn_id' },
			{ name: 'phase' },
			{ name: 'revision' },
			{ name: 'created_at' },
			{ name: 'updated_at' },
			{ name: 'checkpoint_leaf_id' },
			{ name: 'tool_request_json' },
			{ name: 'stream_key' },
			{ name: 'stream_consumed_at' },
			{ name: 'committed' },
			{ name: 'committed_leaf_id' },
		]);
		expect(
			db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
		).toEqual([
			{ name: 'flue_agent_dispatch_receipts' },
			{ name: 'flue_agent_session_deletions' },
			{ name: 'flue_agent_stream_chunks' },
			{ name: 'flue_agent_submissions' },
			{ name: 'flue_agent_turn_journals' },
			{ name: 'flue_session_attachment_deletions' },
			{ name: 'flue_session_blobs' },
			{ name: 'flue_session_entries' },
			{ name: 'flue_sessions' },
			{ name: 'sqlite_sequence' },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_submissions' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: 'flue_agent_submissions_session_status_sequence_idx' },
			{ name: 'flue_agent_submissions_status_sequence_idx' },
			{ name: 'sqlite_autoindex_flue_agent_submissions_1' },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_dispatch_receipts' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: 'sqlite_autoindex_flue_agent_dispatch_receipts_1' }]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_turn_journals' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: 'sqlite_autoindex_flue_agent_turn_journals_1' }]);
	});

	it('ensures only one SQL row per replayed dispatch admission', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		await store.submissions.admitDispatch(dispatchInput());
		await store.submissions.admitDispatch(dispatchInput());

		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_agent_submissions').get()).toEqual({
			count: 1,
		});
	});

	it('terminalizes malformed queued payloads while returning healthy runnable rows', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		await store.submissions.admitDispatch(dispatchInput({ dispatchId: 'healthy' }));
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at)
			 VALUES (?, ?, 'dispatch', ?, 'queued', ?)`,
		).run('malformed', 'agent-session:["agent-1","default","other"]', '{', 1);

		expect(await store.submissions.listRunnableSubmissions()).toEqual([
			expect.objectContaining({ submissionId: 'healthy' }),
		]);
		expect(
			db
				.prepare('SELECT status, error FROM flue_agent_submissions WHERE submission_id = ?')
				.get('malformed'),
		).toMatchObject({ status: 'settled', error: expect.any(String) });
	});

	it('terminalizes impossible queued input markers instead of replaying them', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		await store.submissions.admitDispatch(dispatchInput());
		db.prepare(
			'UPDATE flue_agent_submissions SET input_applied_at = ? WHERE submission_id = ?',
		).run(1, 'dispatch-1');

		expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
		expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'settled',
			error: expect.any(String),
		});
	});

	it('retains dispatch receipt row when a settled session is deleted', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		await store.submissions.admitDispatch(dispatchInput());
		await store.submissions.claimSubmission({
			...attempt('dispatch-1', 'attempt-1'),
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));

		await store.submissions.deleteSession(sessionKey, async () => {});

		expect(
			db
				.prepare(
					'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ?',
				)
				.get('dispatch-1'),
		).toEqual({
			dispatch_id: 'dispatch-1',
			accepted_at: Date.parse('2026-06-03T00:00:00.000Z'),
		});
	});

	it('stores session entries separately and chunks image content when a session is saved', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const imageData = 'a'.repeat(600_000);
		const data = sessionData({
			entries: [
				{
					type: 'message',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					source: 'prompt',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Describe this image.' },
							{ type: 'image', data: imageData, mimeType: 'image/png' },
						],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
		});

		await store.sessions.save('s1', data);

		const sessionRow = db.prepare('SELECT data FROM flue_sessions WHERE id = ?').get('s1') as {
			data: string;
		};
		const entryRows = db
			.prepare('SELECT data FROM flue_session_entries WHERE session_id = ?')
			.all('s1') as Array<{ data: string }>;
		const blobRows = db
			.prepare(
				'SELECT data FROM flue_session_blobs WHERE session_id = ? ORDER BY segment_index ASC',
			)
			.all('s1') as Array<{ data: string }>;

		expect(JSON.parse(sessionRow.data)).not.toHaveProperty('entries');
		expect(sessionRow.data).not.toContain(imageData);
		expect(entryRows).toHaveLength(1);
		expect(entryRows[0]!.data).toContain('__flueSessionBlobRef');
		expect(entryRows[0]!.data).not.toContain(imageData);
		expect(blobRows.length).toBeGreaterThan(1);
		expect(blobRows.map((row) => row.data).join('')).toBe(imageData);
		await expect(store.sessions.load('s1')).resolves.toEqual(data);

		db.prepare(
			'DELETE FROM flue_session_blobs WHERE session_id = ? AND entry_id = ? AND blob_id = ? AND segment_index = ?',
		).run('s1', 'entry-1', 'blob_0', 1);
		await expect(store.sessions.load('s1')).rejects.toThrow(
			'[flue] Persisted session blob row is malformed.',
		);

		await store.sessions.delete('s1');

		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_sessions').get()).toEqual({ count: 0 });
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_session_entries').get()).toEqual({
			count: 0,
		});
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_session_blobs').get()).toEqual({
			count: 0,
		});
	});

	it('stores large image content in an external attachment store when configured', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const attachments = new RecordingAttachmentStore();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent', {
			attachmentStore: attachments,
			externalBlobThreshold: 1,
		});
		const imageData = 'a'.repeat(600_000);
		const data = sessionData({
			entries: [
				{
					type: 'message',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					source: 'prompt',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Describe this image.' },
							{ type: 'image', data: imageData, mimeType: 'image/png' },
						],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
		});

		await store.sessions.save('s1', data);

		const blobRow = db
			.prepare(
				`SELECT storage_kind, object_key, data
				 FROM flue_session_blobs
				 WHERE session_id = ?`,
			)
			.get('s1') as { storage_kind: string; object_key: string; data: string | null };
		const entryRow = db
			.prepare('SELECT data FROM flue_session_entries WHERE session_id = ?')
			.get('s1') as { data: string };

		expect(blobRow.storage_kind).toBe('external');
		expect(blobRow.object_key).toMatch(/^flue-sessions\//);
		expect(blobRow.data).toBeNull();
		expect(attachments.objects.get(blobRow.object_key)).toBe(imageData);
		expect(entryRow.data).toContain('__flueSessionBlobRef');
		expect(entryRow.data).not.toContain(imageData);
		await expect(store.sessions.load('s1')).resolves.toEqual(data);

		await store.sessions.delete('s1');

		expect(attachments.objects.has(blobRow.object_key)).toBe(false);
		expect(attachments.deleted).toEqual([blobRow.object_key]);
	});

	it('retries external attachment cleanup when object deletion fails', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const attachments = new RecordingAttachmentStore();
		let failDelete = true;
		attachments.delete = async (key: string): Promise<void> => {
			attachments.deleted.push(key);
			if (failDelete) throw new Error('r2 unavailable');
			attachments.objects.delete(key);
		};
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent', {
			attachmentStore: attachments,
			externalBlobThreshold: 1,
		});
		const data = sessionData({
			entries: [
				{
					type: 'message',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					source: 'prompt',
					message: {
						role: 'user',
						content: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
		});

		await store.sessions.save('s1', data);
		const objectKey = db
			.prepare('SELECT object_key FROM flue_session_blobs WHERE session_id = ?')
			.get('s1') as { object_key: string };
		await store.sessions.delete('s1');

		expect(attachments.objects.has(objectKey.object_key)).toBe(true);
		expect(db.prepare('SELECT object_key FROM flue_session_attachment_deletions').all()).toEqual([
			{ object_key: objectKey.object_key },
		]);

		failDelete = false;
		await store.sessions.save('s2', sessionData());

		expect(attachments.objects.has(objectKey.object_key)).toBe(false);
		expect(db.prepare('SELECT object_key FROM flue_session_attachment_deletions').all()).toEqual(
			[],
		);
	});

	it('queues external attachment cleanup when a later object upload fails', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const attachments = new RecordingAttachmentStore();
		let putCount = 0;
		let failDelete = true;
		attachments.put = async (key: string, data: string): Promise<void> => {
			putCount++;
			attachments.objects.set(key, data);
			if (putCount === 2) throw new Error('r2 put failed');
		};
		attachments.delete = async (key: string): Promise<void> => {
			attachments.deleted.push(key);
			if (failDelete) throw new Error('r2 delete failed');
			attachments.objects.delete(key);
		};
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent', {
			attachmentStore: attachments,
			externalBlobThreshold: 1,
		});
		const data = sessionData({
			entries: [
				{
					type: 'message',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					source: 'prompt',
					message: {
						role: 'user',
						content: [
							{ type: 'image', data: 'image-1', mimeType: 'image/png' },
							{ type: 'image', data: 'image-2', mimeType: 'image/png' },
						],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
		});

		await expect(store.sessions.save('s1', data)).rejects.toThrow('r2 put failed');

		const queued = db
			.prepare('SELECT object_key FROM flue_session_attachment_deletions ORDER BY object_key')
			.all() as Array<{ object_key: string }>;
		expect(queued).toHaveLength(2);
		expect(attachments.objects.size).toBe(2);

		failDelete = false;
		await store.sessions.save('s2', sessionData());

		expect(attachments.objects.size).toBe(0);
		expect(db.prepare('SELECT object_key FROM flue_session_attachment_deletions').all()).toEqual(
			[],
		);
	});

	it('adapts an R2 bucket binding for session attachment storage', async () => {
		const bucketObjects = new Map<string, string>();
		const bucket = {
			async put(key: string, value: string): Promise<void> {
				bucketObjects.set(key, value);
			},
			async get(key: string): Promise<{ text(): Promise<string> } | null> {
				const value = bucketObjects.get(key);
				return value === undefined ? null : { text: async () => value };
			},
			async delete(key: string): Promise<void> {
				bucketObjects.delete(key);
			},
		};
		const store = createR2SessionAttachmentStore(bucket)!;

		await store.put('object-key', 'image-data');

		expect(await store.get('object-key')).toBe('image-data');
		await store.delete('object-key');
		await expect(store.get('object-key')).rejects.toThrow(
			'[flue] Persisted session attachment object is missing.',
		);
	});

	it('loads legacy session rows when entries still live in flue_sessions', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const data = sessionData({
			entries: [
				{
					type: 'message',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					source: 'prompt',
					message: { role: 'user', content: 'Hello', timestamp: 0 },
				},
			],
			leafId: 'entry-1',
		});
		db.prepare('INSERT INTO flue_sessions (id, data) VALUES (?, ?)').run(
			'legacy',
			JSON.stringify(data),
		);

		await expect(store.sessions.load('legacy')).resolves.toEqual(data);
	});

	it('migrates existing SQL chunk blob tables when session persistence is initialized', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		db.prepare(
			`CREATE TABLE flue_sessions (
			 id TEXT PRIMARY KEY,
			 data TEXT NOT NULL
			)`,
		).run();
		db.prepare(
			`CREATE TABLE flue_session_entries (
			 session_id TEXT NOT NULL,
			 entry_id TEXT NOT NULL,
			 position INTEGER NOT NULL,
			 data TEXT NOT NULL,
			 PRIMARY KEY (session_id, entry_id)
			)`,
		).run();
		db.prepare(
			`CREATE TABLE flue_session_blobs (
			 session_id TEXT NOT NULL,
			 entry_id TEXT NOT NULL,
			 blob_id TEXT NOT NULL,
			 segment_index INTEGER NOT NULL,
			 segment_count INTEGER NOT NULL,
			 data TEXT NOT NULL,
			 PRIMARY KEY (session_id, entry_id, blob_id, segment_index)
			)`,
		).run();

		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_session_blobs') ORDER BY cid").all(),
		).toEqual([
			{ name: 'session_id' },
			{ name: 'entry_id' },
			{ name: 'blob_id' },
			{ name: 'storage_kind' },
			{ name: 'object_key' },
			{ name: 'segment_index' },
			{ name: 'segment_count' },
			{ name: 'data' },
		]);
		expect(
			db
				.prepare(
					"SELECT \"notnull\" AS is_not_null FROM pragma_table_info('flue_session_blobs') WHERE name = 'data'",
				)
				.get(),
		).toEqual({ is_not_null: 0 });
	});

	it('rolls back session blob table migration when copying old rows fails', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		db.prepare(
			`CREATE TABLE flue_session_blobs (
			 session_id TEXT NOT NULL,
			 entry_id TEXT NOT NULL,
			 blob_id TEXT NOT NULL,
			 segment_index INTEGER NOT NULL,
			 segment_count INTEGER NOT NULL,
			 data TEXT NOT NULL,
			 PRIMARY KEY (session_id, entry_id, blob_id, segment_index)
			)`,
		).run();
		db.prepare(
			`INSERT INTO flue_session_blobs
			 (session_id, entry_id, blob_id, segment_index, segment_count, data)
			 VALUES ('s1', 'entry-1', 'blob-1', 0, 1, 'image-data')`,
		).run();
		const failingSql = {
			exec(query: string, ...bindings: unknown[]) {
				if (
					query.includes('INSERT INTO flue_session_blobs') &&
					query.includes('flue_session_blobs_migration_old')
				) {
					throw new Error('copy failed');
				}
				return sql.exec(query, ...bindings);
			},
		};

		expect(() =>
			createSqlAgentExecutionStore({ sql: failingSql, transactionSync }, 'FlueAssistantAgent'),
		).toThrow('copy failed');

		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_session_blobs') ORDER BY cid").all(),
		).toEqual([
			{ name: 'session_id' },
			{ name: 'entry_id' },
			{ name: 'blob_id' },
			{ name: 'segment_index' },
			{ name: 'segment_count' },
			{ name: 'data' },
		]);
		expect(db.prepare('SELECT data FROM flue_session_blobs').get()).toEqual({
			data: 'image-data',
		});
		expect(
			db
				.prepare("SELECT name FROM sqlite_schema WHERE name = 'flue_session_blobs_migration_old'")
				.all(),
		).toEqual([]);
	});

	it('preserves user JSON with blob-ref-like content outside message content when a session is saved', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const data = sessionData({
			entries: [
				{
					type: 'branch_summary',
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					fromId: 'entry-0',
					summary: 'Preserve user details.',
					details: {
						type: 'image',
						data: {
							__flueSessionBlobRef: { type: 'flue.sessionBlob.v1', id: 'user-owned-id' },
						},
						mimeType: 'image/png',
					},
				},
			],
			leafId: 'entry-1',
		});

		await store.sessions.save('s1', data);

		await expect(store.sessions.load('s1')).resolves.toEqual(data);
	});

	it('rejects missing Durable Object SQLite with migration guidance', () => {
		expect(() => createSqlAgentExecutionStore({}, 'FlueAssistantAgent')).toThrow(
			'Add "FlueAssistantAgent" to a Wrangler migration\'s "new_sqlite_classes" list before its first deploy; do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted to SQLite in place.',
		);
	});

	it('rejects SQLite-compatible storage without synchronous transaction support', () => {
		const { sql } = makeFakeSql();

		expect(() => createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent')).toThrow(
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" requires Durable Object SQLite.',
		);
	});

	it('reports SQL initialization failures without misdiagnosing missing SQLite', () => {
		const { sql, transactionSync } = makeFakeSql();
		sql.exec('CREATE TABLE flue_agent_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT)');

		expect(() =>
			createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
		).toThrow(
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" could not initialize its SQLite execution store. Underlying error: no such column: status',
		);
	});
});

describe('createSqlSessionStore()', () => {
	it('creates only normalized session tables when workflow persistence is initialized', () => {
		const { db, sql, transactionSync } = makeFakeSql();

		createSqlSessionStore({ sql, transactionSync });

		expect(
			db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
		).toEqual([
			{ name: 'flue_session_attachment_deletions' },
			{ name: 'flue_session_blobs' },
			{ name: 'flue_session_entries' },
			{ name: 'flue_sessions' },
		]);
		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_sessions') ORDER BY cid").all(),
		).toEqual([{ name: 'id' }, { name: 'data' }]);
		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_session_entries') ORDER BY cid").all(),
		).toEqual([
			{ name: 'session_id' },
			{ name: 'entry_id' },
			{ name: 'position' },
			{ name: 'data' },
		]);
	});
});
