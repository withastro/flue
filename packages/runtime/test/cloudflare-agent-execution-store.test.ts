import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createSqlAgentExecutionStore,
	createSqlSessionStore,
} from '../src/cloudflare/agent-execution-store.ts';
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
					trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || /\bRETURNING\b/i.test(query);
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
			db.prepare("SELECT name FROM pragma_table_info('flue_agent_turn_journals') ORDER BY cid").all(),
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
			db
			.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
			.all(),
		).toEqual([
			{ name: 'flue_agent_dispatch_receipts' },
			{ name: 'flue_agent_session_deletions' },
			{ name: 'flue_agent_stream_chunks' },
			{ name: 'flue_agent_submissions' },
			{ name: 'flue_agent_turn_journals' },
			{ name: 'flue_event_stream_entries' },
			{ name: 'flue_event_streams' },
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
		).toEqual([
			{ name: 'sqlite_autoindex_flue_agent_dispatch_receipts_1' },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_turn_journals' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: 'sqlite_autoindex_flue_agent_turn_journals_1' },
		]);
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
		db.prepare('UPDATE flue_agent_submissions SET input_applied_at = ? WHERE submission_id = ?').run(
			1,
			'dispatch-1',
		);

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
		await store.submissions.claimSubmission({ ...attempt('dispatch-1', 'attempt-1'), ownerId: 'test-owner', leaseExpiresAt: Date.now() + 30_000 });
		await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));

		await store.submissions.deleteSession(sessionKey, async () => {});

		expect(
			db.prepare('SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ?').get(
				'dispatch-1',
			),
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

		expect(() => createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent')).toThrow(
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" could not initialize its SQLite execution store. Underlying error: no such column: status',
		);
	});
});

describe('createSqlSessionStore()', () => {
	it('creates only flue_sessions when workflow-compatible snapshot persistence is initialized', () => {
		const { db, sql } = makeFakeSql();

		createSqlSessionStore(sql);

		expect(
			db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
		).toEqual([{ name: 'flue_sessions' }]);
	});
});
