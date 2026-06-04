import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createSqlAgentExecutionStore,
	createSqlSessionStore,
} from '../src/cloudflare/agent-execution-store.ts';
import type { DirectAgentSubmissionInput } from '../src/runtime/agent-submissions.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';
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
				try {
					rows = stmt.all(...(bindings as never[]));
				} catch {
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

function directInput(overrides: Partial<DirectAgentSubmissionInput> = {}): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId };
}

function sessionData(): SessionData {
	return {
		version: 5,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

describe('createSqlAgentExecutionStore()', () => {
	it('loads, saves, and deletes existing flue_sessions rows when SQLite snapshot persistence is initialized', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		db.exec(
			'CREATE TABLE flue_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
		);
		db.prepare('INSERT INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)').run(
			'existing',
			JSON.stringify(sessionData()),
			1,
		);

		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		expect(await store.sessions.load('existing')).toEqual(sessionData());
		await store.sessions.save('saved', sessionData());
		expect(await store.sessions.load('saved')).toEqual(sessionData());
		await store.sessions.delete('existing');
		expect(await store.sessions.load('existing')).toBeNull();
	});

	it('creates the initial flue_agent_submissions schema and ordering indexes when initialized', () => {
		const { db, sql, transactionSync } = makeFakeSql();

		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		expect(
			db.prepare("SELECT name FROM pragma_table_info('flue_agent_submissions') ORDER BY cid").all(),
		).toEqual([
			{ name: 'sequence' },
			{ name: 'submission_id' },
			{ name: 'session' },
			{ name: 'session_key' },
			{ name: 'kind' },
			{ name: 'payload' },
			{ name: 'status' },
			{ name: 'accepted_at' },
			{ name: 'attempt_id' },
			{ name: 'input_applied_at' },
			{ name: 'recovery_requested_at' },
			{ name: 'started_at' },
			{ name: 'completed_at' },
			{ name: 'error' },
		]);
		expect(
			db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
		).toEqual([
			{ name: 'flue_agent_dispatch_receipts' },
			{ name: 'flue_agent_session_deletions' },
			{ name: 'flue_agent_submissions' },
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
	});

	it('admits one queued dispatch row when the same submission is replayed', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		const first = store.submissions.admitDispatch(dispatchInput());
		const replay = store.submissions.admitDispatch(dispatchInput());

		expect(replay).toEqual(first);
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_agent_submissions').get()).toEqual({
			count: 1,
		});
		expect(first).toMatchObject({
			kind: 'submission',
			submission: {
				submissionId: 'dispatch-1',
				session: 'default',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				status: 'queued',
			},
		});
	});

	it('rejects conflicting replay when one dispatch id is reused with another payload', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());

		expect(() =>
			store.submissions.admitDispatch(dispatchInput({ input: { text: 'Different' } })),
		).toThrow('[flue] Conflicting internal dispatch replay.');
	});

	it('orders direct and dispatched submissions together within one session', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const direct = store.submissions.admitDirect(directInput());
		store.submissions.admitDispatch(dispatchInput());
		const other = store.submissions.admitDirect(directInput({ submissionId: 'direct-2', session: 'other' }));

		expect(store.submissions.listRunnableSubmissions()).toEqual([direct, other]);
		expect(store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-blocked'))).toBeNull();
		expect(store.submissions.claimSubmission(attempt('direct-1', 'attempt-direct'))).toMatchObject({
			kind: 'direct',
			status: 'running',
		});
	});

	it('lists queued dispatches in admission order and selects one runnable head per session', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-2' }));
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-3', session: 'other' }));

		expect(store.submissions.listRunnableSubmissions()).toEqual([
			expect.objectContaining({ submissionId: 'dispatch-1' }),
			expect.objectContaining({ submissionId: 'dispatch-3' }),
		]);
	});

	it('claims only runnable session heads while allowing separate sessions to claim independently', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-2' }));
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-3', session: 'other' }));

		const first = store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
		const blocked = store.submissions.claimSubmission(attempt('dispatch-2', 'attempt-2'));
		const other = store.submissions.claimSubmission(attempt('dispatch-3', 'attempt-3'));

		expect(first).toMatchObject({
			submissionId: 'dispatch-1',
			status: 'running',
			attemptId: 'attempt-1',
			startedAt: expect.any(Number),
		});
		expect(blocked).toBeNull();
		expect(other).toMatchObject({
			submissionId: 'dispatch-3',
			status: 'running',
			attemptId: 'attempt-3',
		});
		expect(store.submissions.listRunningSubmissions()).toEqual([first, other]);
		expect(store.submissions.listRunnableSubmissions()).toEqual([]);
	});

	it('terminalizes malformed queued payloads while returning healthy runnable rows', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'healthy' }));
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session, session_key, kind, payload, status, accepted_at)
			 VALUES (?, ?, ?, 'dispatch', ?, 'queued', ?)`,
		).run('malformed', 'other', 'agent-session:["agent-1","default","other"]', '{', 1);

		expect(store.submissions.listRunnableSubmissions()).toEqual([
			expect.objectContaining({ submissionId: 'healthy' }),
		]);
		expect(
			db
				.prepare('SELECT status, error FROM flue_agent_submissions WHERE submission_id = ?')
				.get('malformed'),
		).toMatchObject({ status: 'failed', error: expect.any(String) });
	});

	it('terminalizes impossible queued input markers instead of replaying them', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		db.prepare('UPDATE flue_agent_submissions SET input_applied_at = ? WHERE submission_id = ?').run(
			1,
			'dispatch-1',
		);

		expect(store.submissions.listRunnableSubmissions()).toEqual([]);
		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'failed',
			error: expect.any(String),
		});
	});

	it('records input application and recovery requests only for the owning running attempt', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

		expect(store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1'))).toBe(true);
		const appliedAt = store.submissions.getSubmission('dispatch-1')?.inputAppliedAt;
		expect(store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1'))).toBe(true);
		expect(store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'stale-attempt'))).toBe(false);
		expect(store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'attempt-1'))).toBe(true);
		expect(store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'stale-attempt'))).toBe(false);

		expect(appliedAt).toEqual(expect.any(Number));
		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'running',
			attemptId: 'attempt-1',
			inputAppliedAt: appliedAt,
			recoveryRequestedAt: expect.any(Number),
		});
	});

	it('requeues interrupted attempts only before canonical input application', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'requeue-safe' }));
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'requeue-unsafe', session: 'other' }));
		store.submissions.claimSubmission(attempt('requeue-safe', 'attempt-safe'));
		store.submissions.claimSubmission(attempt('requeue-unsafe', 'attempt-unsafe'));
		store.submissions.markSubmissionInputApplied(attempt('requeue-unsafe', 'attempt-unsafe'));

		const safe = store.submissions.requeueSubmissionBeforeInputApplied(attempt('requeue-safe', 'attempt-safe'));
		const unsafe = store.submissions.requeueSubmissionBeforeInputApplied(attempt('requeue-unsafe', 'attempt-unsafe'));

		expect(safe).toBe(true);
		expect(unsafe).toBe(false);
		expect(store.submissions.getSubmission('requeue-safe')).toMatchObject({ status: 'queued' });
		expect(store.submissions.getSubmission('requeue-safe')).not.toHaveProperty('attemptId');
		expect(store.submissions.getSubmission('requeue-unsafe')).toMatchObject({ status: 'running' });
	});

	it('reports unsettled session visibility until a claimed dispatch completes', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ session: 'case-1' }));

		expect(store.submissions.hasUnsettledSubmissions()).toBe(true);
		expect(store.submissions.listRunnableSubmissions()).toHaveLength(1);
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
		expect(store.submissions.listRunningSubmissions()).toHaveLength(1);
		store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
		expect(store.submissions.hasUnsettledSubmissions()).toBe(false);
		expect(store.submissions.listRunningSubmissions()).toEqual([]);
		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({ status: 'completed' });
	});

	it('ignores stale-attempt settlement and keeps the first owning terminal dispatch state', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

		store.submissions.completeSubmission(attempt('dispatch-1', 'stale-attempt'));
		store.submissions.failSubmission(attempt('dispatch-1', 'attempt-1'), new Error('first failure'));
		store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
		store.submissions.failSubmission(attempt('dispatch-1', 'attempt-1'), new Error('later failure'));

		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'failed',
			error: 'first failure',
		});
	});

	it('fences ordinary completion while an interrupted submission records its advisory', () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

		expect(store.submissions.beginSubmissionInterruptionRecording(attempt('dispatch-1', 'attempt-1'))).toBe(
			true,
		);
		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'recording_interruption',
		});
		expect(store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'))).toBe(false);
		expect(
			store.submissions.finishSubmissionInterruptionRecording(
				attempt('dispatch-1', 'attempt-1'),
				new Error('interrupted'),
			),
		).toBe(true);
		expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'failed',
			error: 'interrupted',
		});
	});

	it('rejects session deletion while durable submissions are queued or running', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());

		await expect(
			store.submissions.deleteSession('agent-session:["agent-1","default","default"]', async () => {}),
		).rejects.toThrow('Session cannot be deleted while durable agent submissions are queued or running.');

		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
		await expect(
			store.submissions.deleteSession('agent-session:["agent-1","default","default"]', async () => {}),
		).rejects.toThrow('Session cannot be deleted while durable agent submissions are queued or running.');
	});

	it('blocks new submissions until session deletion completes', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		let releaseDeletion: () => void = () => {};
		const deletionReleased = new Promise<void>((resolve) => {
			releaseDeletion = resolve;
		});

		const deletion = store.submissions.deleteSession(sessionKey, () => deletionReleased);
		expect(() => store.submissions.admitDispatch(dispatchInput())).toThrow(
			'Durable agent submission admission is unavailable while this session is being deleted.',
		);
		releaseDeletion();
		await deletion;
		expect(store.submissions.admitDispatch(dispatchInput())).toMatchObject({ kind: 'submission', submission: { status: 'queued' } });
	});

	it('shares session deletion work while snapshot deletion is in progress', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		let releaseDeletion: () => void = () => {};
		const deletionReleased = new Promise<void>((resolve) => {
			releaseDeletion = resolve;
		});
		let deletionCalls = 0;

		const first = store.submissions.deleteSession(sessionKey, async () => {
			deletionCalls += 1;
			await deletionReleased;
		});
		const second = store.submissions.deleteSession(sessionKey, async () => {
			deletionCalls += 1;
		});

		expect(second).toBe(first);
		expect(deletionCalls).toBe(1);
		expect(() => store.submissions.admitDispatch(dispatchInput())).toThrow(
			'Durable agent submission admission is unavailable while this session is being deleted.',
		);
		releaseDeletion();
		await Promise.all([first, second]);
		expect(store.submissions.admitDispatch(dispatchInput())).toMatchObject({ kind: 'submission', submission: { status: 'queued' } });
	});

	it('keeps new submissions blocked when session snapshot deletion fails', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';

		await expect(
			store.submissions.deleteSession(sessionKey, async () => {
				throw new Error('snapshot deletion failed');
			}),
		).rejects.toThrow('snapshot deletion failed');
		expect(() => store.submissions.admitDispatch(dispatchInput())).toThrow(
			'Durable agent submission admission is unavailable while this session is being deleted.',
		);
		await expect(store.submissions.deleteSession(sessionKey, async () => {})).resolves.toBeUndefined();
		expect(store.submissions.admitDispatch(dispatchInput())).toMatchObject({ kind: 'submission', submission: { status: 'queued' } });
	});

	it('clears terminal rows when a settled session is deleted', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
		store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));

		await store.submissions.deleteSession(sessionKey, async () => {});

		expect(store.submissions.getSubmission('dispatch-1')).toBeNull();
		expect(
			db.prepare('SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ?').get(
				'dispatch-1',
			),
		).toEqual({
			dispatch_id: 'dispatch-1',
			accepted_at: Date.parse('2026-06-03T00:00:00.000Z'),
		});
	});

	it('returns retained receipt admission transactionally when deletion removed the settled dispatch row', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const sessionKey = 'agent-session:["agent-1","default","default"]';
		store.submissions.admitDispatch(dispatchInput());
		store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
		store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
		await store.submissions.deleteSession(sessionKey, async () => {});

		expect(store.submissions.admitDispatch(dispatchInput())).toEqual({
			kind: 'retained_receipt',
			receipt: {
				submissionId: 'dispatch-1',
				acceptedAt: Date.parse('2026-06-03T00:00:00.000Z'),
			},
		});
		expect(store.submissions.getSubmission('dispatch-1')).toBeNull();
	});

	it('sweeps only expired terminal submissions in bounded batches', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'expired-1' }));
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'expired-2', session: 'other' }));
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'active', session: 'active' }));
		store.submissions.claimSubmission(attempt('expired-1', 'attempt-1'));
		store.submissions.claimSubmission(attempt('expired-2', 'attempt-2'));
		store.submissions.completeSubmission(attempt('expired-1', 'attempt-1'));
		store.submissions.failSubmission(attempt('expired-2', 'attempt-2'), new Error('failed'));
		db.prepare("UPDATE flue_agent_submissions SET completed_at = 1 WHERE status IN ('completed', 'failed')").run();

		expect(store.submissions.cleanupTerminalSubmissions(2, 1)).toBe(1);
		expect(store.submissions.cleanupTerminalSubmissions(2, 1)).toBe(1);
		expect(store.submissions.cleanupTerminalSubmissions(2, 1)).toBe(0);
		expect(db.prepare('SELECT dispatch_id FROM flue_agent_dispatch_receipts').all()).toEqual([]);
		expect(store.submissions.getSubmission('active')).toMatchObject({ status: 'queued' });
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
