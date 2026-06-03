import type { DispatchInput } from '../runtime/dispatch-queue.ts';
import { createSessionStorageKey } from '../session-identity.ts';
import type { SessionData, SessionStore } from '../types.ts';

interface SqlResult {
	toArray(): SqlRow[];
}

type SqlRow = Record<string, unknown>;

interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
}

type SqlAgentSubmissionStatus = 'queued' | 'completed' | 'error';

export interface SqlAgentDispatchSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly session: string;
	readonly sessionKey: string;
	readonly input: DispatchInput;
	readonly status: SqlAgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly completedAt?: number;
	readonly error?: string;
}

export interface SqlAgentSubmissionStore {
	getDispatch(submissionId: string): SqlAgentDispatchSubmission | null;
	admitDispatch(input: DispatchInput): SqlAgentDispatchSubmission;
	hasQueuedDispatches(): boolean;
	listQueuedDispatches(): SqlAgentDispatchSubmission[];
	listRunnableDispatches(): SqlAgentDispatchSubmission[];
	hasQueuedDispatchForSession(instanceId: string, session: string): boolean;
	hasEarlierQueuedDispatch(submission: SqlAgentDispatchSubmission): boolean;
	completeDispatch(submissionId: string): void;
	failDispatch(submissionId: string, error: unknown): void;
}

export interface SqlAgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: SqlAgentSubmissionStore;
}

export class SqlAgentSubmissionConflictError extends Error {}

export function createSqlSessionStore(sql: SqlStorage): SessionStore {
	ensureSessionTable(sql);
	return new SqlSessionStore(sql);
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): SqlAgentExecutionStore {
	const sql = storage?.sql;
	if (!sql || typeof sql.exec !== 'function') {
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
				`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
				`do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ` +
				`to SQLite in place.`,
		);
	}
	try {
		const sessions = createSqlSessionStore(sql);
		ensureSubmissionTable(sql);
		return { sessions, submissions: new SqlAgentSubmissionStoreImpl(sql) };
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" could not initialize its SQLite execution store. ` +
				`Underlying error: ${detail}`,
			{ cause },
		);
	}
}

class SqlSessionStore implements SessionStore {
	constructor(private sql: SqlStorage) {}

	async save(id: string, data: SessionData): Promise<void> {
		this.sql.exec(
			'INSERT OR REPLACE INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)',
			id,
			JSON.stringify(data),
			Date.now(),
		);
	}

	async load(id: string): Promise<SessionData | null> {
		const rows = this.sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
		const row = rows[0];
		if (!row) return null;
		if (typeof row.data !== 'string') throw new Error('[flue] Persisted session row is malformed.');
		return JSON.parse(row.data) as SessionData;
	}

	async delete(id: string): Promise<void> {
		this.sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
	}
}

class SqlAgentSubmissionStoreImpl implements SqlAgentSubmissionStore {
	constructor(private sql: SqlStorage) {}

	getDispatch(submissionId: string): SqlAgentDispatchSubmission | null {
		const row = this.readDispatchRow(submissionId);
		return row ? parseDispatchSubmission(row) : null;
	}

	admitDispatch(input: DispatchInput): SqlAgentDispatchSubmission {
		const payload = JSON.stringify(input);
		const acceptedAt = Date.parse(input.acceptedAt);
		if (!Number.isFinite(acceptedAt)) {
			throw new Error('[flue] Internal dispatch admission received an invalid acceptedAt timestamp.');
		}
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_agent_submissions
			 (submission_id, session, session_key, kind, payload, status, accepted_at)
			 VALUES (?, ?, ?, 'dispatch', ?, 'queued', ?)`,
			input.dispatchId,
			input.session,
			createSessionStorageKey(input.id, 'default', input.session),
			payload,
			acceptedAt,
		);
		const row = this.readDispatchRow(input.dispatchId);
		if (!row) throw new Error('[flue] Durable dispatch admission did not create a submission row.');
		if (row.payload !== payload) {
			throw new SqlAgentSubmissionConflictError('[flue] Conflicting internal dispatch replay.');
		}
		return parseDispatchSubmission(row);
	}

	hasQueuedDispatches(): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE kind = 'dispatch' AND status = 'queued'
					 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	listQueuedDispatches(): SqlAgentDispatchSubmission[] {
		return this.parseQueuedRows(
			this.sql
				.exec(
					`SELECT sequence, submission_id, session, session_key, kind, payload, status,
					        accepted_at, completed_at, error
					 FROM flue_agent_submissions
					 WHERE kind = 'dispatch' AND status = 'queued'
					 ORDER BY sequence ASC`,
				)
				.toArray(),
		);
	}

	listRunnableDispatches(): SqlAgentDispatchSubmission[] {
		const rows = this.sql
			.exec(
				`SELECT current.sequence, current.submission_id, current.session, current.session_key,
				        current.kind, current.payload, current.status, current.accepted_at,
				        current.completed_at, current.error
				 FROM flue_agent_submissions AS current
				 WHERE current.kind = 'dispatch' AND current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.kind = 'dispatch'
				       AND earlier.session_key = current.session_key
				       AND earlier.status = 'queued'
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseQueuedRows(rows);
	}

	hasQueuedDispatchForSession(instanceId: string, session: string): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE kind = 'dispatch' AND session_key = ? AND status = 'queued'
					 LIMIT 1`,
					createSessionStorageKey(instanceId, 'default', session),
				)
				.toArray().length > 0
		);
	}

	hasEarlierQueuedDispatch(submission: SqlAgentDispatchSubmission): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE kind = 'dispatch' AND session_key = ? AND status = 'queued' AND sequence < ?
					 LIMIT 1`,
					submission.sessionKey,
					submission.sequence,
				)
				.toArray().length > 0
		);
	}

	completeDispatch(submissionId: string): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'completed', completed_at = ?, error = NULL
			 WHERE submission_id = ? AND kind = 'dispatch' AND status = 'queued'`,
			Date.now(),
			submissionId,
		);
	}

	failDispatch(submissionId: string, error: unknown): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'error', completed_at = ?, error = ?
			 WHERE submission_id = ? AND kind = 'dispatch' AND status = 'queued'`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			submissionId,
		);
	}

	private parseQueuedRows(rows: SqlRow[]): SqlAgentDispatchSubmission[] {
		const submissions: SqlAgentDispatchSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(parseDispatchSubmission(row));
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				this.failDispatchSequence(row.sequence, error);
			}
		}
		return submissions;
	}

	private failDispatchSequence(sequence: number, error: unknown): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'error', completed_at = ?, error = ?
			 WHERE sequence = ? AND kind = 'dispatch' AND status = 'queued'`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			sequence,
		);
	}

	private readDispatchRow(submissionId: string): SqlRow | undefined {
		return this.sql
			.exec(
				`SELECT sequence, submission_id, session, session_key, kind, payload, status,
				        accepted_at, completed_at, error
				 FROM flue_agent_submissions
				 WHERE submission_id = ? AND kind = 'dispatch'
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
	}
}

function parseDispatchSubmission(row: SqlRow): SqlAgentDispatchSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session !== 'string' ||
		typeof row.session_key !== 'string' ||
		row.kind !== 'dispatch' ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' && row.status !== 'completed' && row.status !== 'error') ||
		typeof row.accepted_at !== 'number'
	) {
		throw new Error('[flue] Persisted dispatch submission row is malformed.');
	}
	const input = JSON.parse(row.payload) as DispatchInput;
	if (
		!input ||
		typeof input !== 'object' ||
		typeof input.dispatchId !== 'string' ||
		typeof input.agent !== 'string' ||
		typeof input.id !== 'string' ||
		typeof input.session !== 'string' ||
		input.input === undefined ||
		typeof input.acceptedAt !== 'string' ||
		input.dispatchId !== row.submission_id ||
		input.session !== row.session ||
		createSessionStorageKey(input.id, 'default', input.session) !== row.session_key ||
		Date.parse(input.acceptedAt) !== row.accepted_at
	) {
		throw new Error('[flue] Persisted dispatch submission payload is malformed.');
	}
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
		session: row.session,
		sessionKey: row.session_key,
		input,
		status: row.status,
		acceptedAt: row.accepted_at,
		...(typeof row.completed_at === 'number' ? { completedAt: row.completed_at } : {}),
		...(typeof row.error === 'string' ? { error: row.error } : {}),
	};
}

function ensureSessionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_sessions (
		 id TEXT PRIMARY KEY,
		 data TEXT NOT NULL,
		 updated_at INTEGER NOT NULL
		)`,
	);
}

function ensureSubmissionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (
		 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		 submission_id TEXT NOT NULL UNIQUE,
		 session TEXT NOT NULL,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 status TEXT NOT NULL,
		 accepted_at INTEGER NOT NULL,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 started_at INTEGER,
		 completed_at INTEGER,
		 error TEXT
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
}
