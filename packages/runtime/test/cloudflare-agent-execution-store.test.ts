import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createSqlAgentExecutionStore,
	createSqlSessionStore,
} from '../src/cloudflare/agent-execution-store.ts';
import { IMAGE_DATA_CHUNK_LENGTH } from '../src/persisted-images.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';

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
		input: { text: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId };
}

describe('createSqlAgentExecutionStore()', () => {
	it('creates the initial flue_agent_submissions schema and ordering indexes when initialized', () => {
		const { db, sql, transactionSync } = makeFakeSql();

		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		const columnNames = (table: string) =>
			new Set(
				(
					db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
						name: string;
					}>
				).map((row) => row.name),
			);
		expect(columnNames('flue_agent_submissions')).toEqual(
			new Set([
				'sequence',
				'submission_id',
				'session_key',
				'kind',
				'payload',
				'status',
				'accepted_at',
				'attempt_id',
				'canonical_ready_at',
				'input_applied_at',
				'recovery_requested_at',
				'started_at',
				'settled_at',
				'error',
				'attempt_count',
				'max_retry',
				'timeout_at',
				'owner_id',
				'lease_expires_at',
				'settlement_record_id',
				'settlement_record_json',
			]),
		);
		expect(columnNames('flue_agent_turn_journals')).toEqual(
			new Set([
				'submission_id',
				'session_key',
				'kind',
				'attempt_id',
				'operation_id',
				'turn_id',
				'phase',
				'revision',
				'created_at',
				'updated_at',
				'checkpoint_leaf_id',
				'tool_request_json',
				'committed',
				'committed_leaf_id',
			]),
		);
		const tableNames = new Set(
			(
				db
					.prepare(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.all() as Array<{ name: string }>
			).map((row) => row.name),
		);
		expect(tableNames).toEqual(
			new Set([
				'flue_agent_attempt_markers',
				'flue_agent_dispatch_receipts',
				'flue_agent_session_deletions',
				'flue_agent_submissions',
				'flue_agent_turn_journals',
				'flue_image_chunks',
				'flue_meta',
				'flue_session_entries',
				'flue_sessions',
			]),
		);
		const submissionIndexNames = (
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_submissions'",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(submissionIndexNames).toEqual(
			expect.arrayContaining([
				'flue_agent_submissions_session_status_sequence_idx',
				'flue_agent_submissions_status_sequence_idx',
			]),
		);
	});

	it('chunks and hydrates session images and removes chunks on deletion', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const imageData = 'a'.repeat(IMAGE_DATA_CHUNK_LENGTH + 7);
		const data = {
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'user' as const,
						content: [{ type: 'image' as const, data: imageData, mimeType: 'image/png' }],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		};
		await store.save('session-1', data);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM flue_image_chunks WHERE owner_kind = 'session_entry'",
				)
				.get(),
		).toEqual({ count: 2 });
		expect(await store.load('session-1')).toEqual(data);

		const updatedImageData = 'b'.repeat(IMAGE_DATA_CHUNK_LENGTH + 7);
		const updated = structuredClone(data);
		const content = updated.entries[0]?.message.content;
		if (!Array.isArray(content) || content[0]?.type !== 'image') throw new Error('invalid fixture');
		content[0].data = updatedImageData;
		await store.save('session-1', updated);
		expect(await store.load('session-1')).toEqual(updated);

		await store.delete('session-1');
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_image_chunks').get()).toEqual({
			count: 0,
		});
	});

	it('keeps four-byte Unicode image chunks safely below the row limit', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const imageData = '😀'.repeat(IMAGE_DATA_CHUNK_LENGTH / 2 + 1);
		const data = {
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: 'unicode-entry',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'user' as const,
						content: [{ type: 'image' as const, data: imageData, mimeType: 'image/png' }],
						timestamp: 0,
					},
				},
			],
			leafId: 'unicode-entry',
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		};
		await store.save('unicode-session', data);
		const chunks = db
			.prepare('SELECT data FROM flue_image_chunks ORDER BY chunk_index')
			.all() as Array<{ data: string }>;
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk.data, 'utf8')).toBeLessThan(2 * 1024 * 1024);
		}
		expect(await store.load('unicode-session')).toEqual(data);
	});

	it('stores direct submission images outside the submission payload', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const imageData = 'a'.repeat(IMAGE_DATA_CHUNK_LENGTH + 1);
		const input = {
			kind: 'direct' as const,
			submissionId: 'direct-1',
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			payload: {
				message: 'hello',
				images: [{ type: 'image' as const, data: imageData, mimeType: 'image/png' }],
			},
		};
		const submission = await store.submissions.admitDirect(input);
		const replay = await store.submissions.admitDirect(input);
		const row = db
			.prepare('SELECT payload FROM flue_agent_submissions WHERE submission_id = ?')
			.get('direct-1') as { payload: string };
		expect(row.payload).not.toContain(imageData);
		expect(submission.input).toMatchObject({ payload: { images: [{ data: imageData }] } });
		expect(replay.input).toEqual(submission.input);
		expect(
			db
				.prepare("SELECT COUNT(*) AS count FROM flue_image_chunks WHERE owner_kind = 'submission'")
				.get(),
		).toEqual({ count: 2 });
		await expect(
			store.submissions.admitDirect({
				...input,
				payload: {
					...input.payload,
					images: [{ type: 'image', data: `b${imageData.slice(1)}`, mimeType: 'image/png' }],
				},
			}),
		).rejects.toThrow('unexpected result');
	});

	it('replays direct submissions with more than ten images exactly', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const input = {
			kind: 'direct' as const,
			submissionId: 'direct-many-images',
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			payload: {
				message: 'hello',
				images: Array.from({ length: 12 }, (_, index) => ({
					type: 'image' as const,
					data: `image-${index}`,
					mimeType: 'image/png',
				})),
			},
		};
		const admitted = await store.submissions.admitDirect(input);
		const replay = await store.submissions.admitDirect(input);
		expect(replay.input).toEqual(admitted.input);
	});

	it('round-trips tool-result images', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const data = {
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: 'tool-entry',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'toolResult' as const,
						toolCallId: 'call-1',
						toolName: 'camera',
						content: [{ type: 'image' as const, data: 'image-data', mimeType: 'image/png' }],
						isError: false,
						timestamp: 0,
					},
				},
			],
			leafId: 'tool-entry',
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		};
		await store.save('tool-session', data);
		expect(await store.load('tool-session')).toEqual(data);
	});

	it('rejects missing image chunks during hydration', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const data = {
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'user' as const,
						content: [
							{
								type: 'image' as const,
								data: 'a'.repeat(IMAGE_DATA_CHUNK_LENGTH + 1),
								mimeType: 'image/png',
							},
						],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		};
		await store.save('session-1', data);
		db.prepare('DELETE FROM flue_image_chunks WHERE chunk_index = 1').run();
		await expect(store.load('session-1')).rejects.toThrow('missing or malformed');
	});

	it('rejects unreferenced persisted image chunk groups', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const data = {
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: 'entry-1',
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'user' as const,
						content: [{ type: 'image' as const, data: 'image-data', mimeType: 'image/png' }],
						timestamp: 0,
					},
				},
			],
			leafId: 'entry-1',
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		};
		await store.save('session-1', data);
		db.prepare(
			`INSERT INTO flue_image_chunks
			 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
			 VALUES ('session_entry', 'session-1', 'entry-1', 'extra', 0, 1, 'extra')`,
		).run();
		await expect(store.load('session-1')).rejects.toThrow('do not match persisted image markers');
	});

	it('isolates session image ownership for punctuation and wildcard identifiers', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		const createData = (entryId: string, imageData: string) => ({
			version: 8 as const,
			conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
			childSessions: [],
			entries: [
				{
					type: 'message' as const,
					id: entryId,
					parentId: null,
					timestamp: '2026-06-03T00:00:00.000Z',
					message: {
						role: 'user' as const,
						content: [{ type: 'image' as const, data: imageData, mimeType: 'image/png' }],
						timestamp: 0,
					},
				},
			],
			leafId: entryId,
			metadata: {},
			createdAt: '2026-06-03T00:00:00.000Z',
			updatedAt: '2026-06-03T00:00:00.000Z',
		});
		const first = createData('entry:%_', 'first');
		const second = createData('entry', 'second');
		await store.save('session:%_', first);
		await store.save('session', second);
		await store.delete('session:%_');
		expect(await store.load('session')).toEqual(second);
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_image_chunks').get()).toEqual({
			count: 1,
		});
	});

	it('rejects persisted session images over the encoded length limit', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlSessionStore({ sql, transactionSync });
		await expect(
			store.save('session-1', {
				version: 8,
				childSessions: [],
				conversationId: 'conv_00000000000000000000000000',
			affinityKey: 'aff_00000000000000000000000000',
				entries: [
					{
						type: 'message',
						id: 'entry-1',
						parentId: null,
						timestamp: '2026-06-03T00:00:00.000Z',
						message: {
							role: 'user',
							content: [
								{ type: 'image', data: 'a'.repeat(14 * 1024 * 1024 + 1), mimeType: 'image/png' },
							],
							timestamp: 0,
						},
					},
				],
				leafId: 'entry-1',
				metadata: {},
				createdAt: '2026-06-03T00:00:00.000Z',
				updatedAt: '2026-06-03T00:00:00.000Z',
			}),
		).rejects.toThrow('Image data exceeds');
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
		await store.submissions.markSubmissionCanonicalReady('healthy');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, canonical_ready_at)
			 VALUES (?, ?, 'dispatch', ?, 'queued', ?, ?)`,
		).run('malformed', 'agent-session:["agent-1","default","other"]', '{', 1, 1);

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
		await store.submissions.markSubmissionCanonicalReady('dispatch-1');
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
		await store.submissions.markSubmissionCanonicalReady('dispatch-1');
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
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" could not initialize its SQLite execution store. Underlying error: This database records an unrecognized schema version ("unversioned"; this runtime supports version 5).',
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
			{ name: 'flue_image_chunks' },
			{ name: 'flue_meta' },
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
