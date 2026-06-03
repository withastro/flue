import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	createSqlAgentExecutionStore,
	createSqlSessionStore,
} from '../src/cloudflare/agent-execution-store.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';
import type { SessionData } from '../src/types.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
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
		const { db, sql } = makeFakeSql();
		db.exec(
			'CREATE TABLE flue_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
		);
		db.prepare('INSERT INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)').run(
			'existing',
			JSON.stringify(sessionData()),
			1,
		);

		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');

		expect(await store.sessions.load('existing')).toEqual(sessionData());
		await store.sessions.save('saved', sessionData());
		expect(await store.sessions.load('saved')).toEqual(sessionData());
		await store.sessions.delete('existing');
		expect(await store.sessions.load('existing')).toBeNull();
	});

	it('creates the initial flue_agent_submissions schema and ordering indexes when initialized', () => {
		const { db, sql } = makeFakeSql();

		createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');

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
			{ name: 'started_at' },
			{ name: 'completed_at' },
			{ name: 'error' },
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
		const { db, sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');

		const first = store.submissions.admitDispatch(dispatchInput());
		const replay = store.submissions.admitDispatch(dispatchInput());

		expect(replay).toEqual(first);
		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_agent_submissions').get()).toEqual({
			count: 1,
		});
		expect(first).toMatchObject({
			submissionId: 'dispatch-1',
			session: 'default',
			sessionKey: 'agent-session:["agent-1","default","default"]',
			status: 'queued',
		});
	});

	it('rejects conflicting replay when one dispatch id is reused with another payload', () => {
		const { sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());

		expect(() =>
			store.submissions.admitDispatch(dispatchInput({ input: { text: 'Different' } })),
		).toThrow('[flue] Conflicting internal dispatch replay.');
	});

	it('lists queued dispatches in admission order and selects one runnable head per session', () => {
		const { sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');
		const first = store.submissions.admitDispatch(dispatchInput());
		const second = store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-2' }));
		const other = store.submissions.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch-3', session: 'other' }),
		);

		expect(store.submissions.listQueuedDispatches()).toEqual([first, second, other]);
		expect(store.submissions.listRunnableDispatches()).toEqual([first, other]);
		expect(store.submissions.hasEarlierQueuedDispatch(first)).toBe(false);
		expect(store.submissions.hasEarlierQueuedDispatch(second)).toBe(true);
		expect(store.submissions.hasEarlierQueuedDispatch(other)).toBe(false);
	});

	it('terminalizes malformed queued payloads while returning healthy runnable rows', () => {
		const { db, sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ dispatchId: 'healthy' }));
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session, session_key, kind, payload, status, accepted_at)
			 VALUES (?, ?, ?, 'dispatch', ?, 'queued', ?)`,
		).run('malformed', 'other', 'agent-session:["agent-1","default","other"]', '{', 1);

		expect(store.submissions.listRunnableDispatches()).toEqual([
			expect.objectContaining({ submissionId: 'healthy' }),
		]);
		expect(
			db
				.prepare('SELECT status, error FROM flue_agent_submissions WHERE submission_id = ?')
				.get('malformed'),
		).toMatchObject({ status: 'error', error: expect.any(String) });
	});

	it('reports queued session visibility until a dispatch completes', () => {
		const { sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput({ session: 'case-1' }));

		expect(store.submissions.hasQueuedDispatchForSession('agent-1', 'case-1')).toBe(true);
		expect(store.submissions.hasQueuedDispatchForSession('agent-1', 'case-2')).toBe(false);
		store.submissions.completeDispatch('dispatch-1');
		expect(store.submissions.hasQueuedDispatchForSession('agent-1', 'case-1')).toBe(false);
		expect(store.submissions.getDispatch('dispatch-1')).toMatchObject({ status: 'completed' });
	});

	it('keeps the first terminal dispatch state when a later settlement races it', () => {
		const { sql } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent');
		store.submissions.admitDispatch(dispatchInput());

		store.submissions.failDispatch('dispatch-1', new Error('first failure'));
		store.submissions.completeDispatch('dispatch-1');
		store.submissions.failDispatch('dispatch-1', new Error('later failure'));

		expect(store.submissions.getDispatch('dispatch-1')).toMatchObject({
			status: 'error',
			error: 'first failure',
		});
	});

	it('rejects missing Durable Object SQLite with migration guidance', () => {
		expect(() => createSqlAgentExecutionStore({}, 'FlueAssistantAgent')).toThrow(
			'Add "FlueAssistantAgent" to a Wrangler migration\'s "new_sqlite_classes" list before its first deploy; do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted to SQLite in place.',
		);
	});

	it('reports SQL initialization failures without misdiagnosing missing SQLite', () => {
		const { sql } = makeFakeSql();
		sql.exec('CREATE TABLE flue_agent_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT)');

		expect(() => createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent')).toThrow(
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
