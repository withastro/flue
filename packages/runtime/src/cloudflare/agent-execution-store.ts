import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
	type DispatchAgentSubmissionInput,
} from '../runtime/agent-submissions.ts';
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
	transactionSync?<T>(closure: () => T): T;
}

type SqlAgentSubmissionStatus = 'queued' | 'running' | 'terminalizing' | 'completed' | 'error';

export interface SqlAgentDispatchReceipt {
	readonly submissionId: string;
	readonly acceptedAt: number;
}

export interface SqlAgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly session: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: SqlAgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	readonly recoveryRequestedAt?: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly error?: string;
}

export interface SqlAgentSubmissionStore {
	getSubmission(submissionId: string): SqlAgentSubmission | null;
	admitDispatch(input: DispatchInput): SqlAgentSubmission;
	admitDirect(input: DirectAgentSubmissionInput): SqlAgentSubmission;
	hasUnsettledSubmissions(): boolean;
	listRunnableSubmissions(): SqlAgentSubmission[];
	listRunningSubmissions(): SqlAgentSubmission[];
	beginSessionDeletion(sessionKey: string): void;
	finishSessionDeletion(sessionKey: string): void;
	cleanupTerminalSubmissions(completedBefore: number, limit?: number): number;
	claimSubmission(submissionId: string, attemptId: string): SqlAgentSubmission | null;
	markSubmissionInputApplied(submissionId: string, attemptId: string): SqlAgentSubmission | null;
	requestSubmissionRecovery(submissionId: string, attemptId: string): SqlAgentSubmission | null;
	requeueSubmissionBeforeInputApplied(
		submissionId: string,
		attemptId: string,
	): SqlAgentSubmission | null;
	beginSubmissionTerminalization(submissionId: string, attemptId: string): SqlAgentSubmission | null;
	completeSubmission(submissionId: string, attemptId: string): boolean;
	failSubmission(submissionId: string, attemptId: string, error: unknown): boolean;
	finalizeSubmissionTerminalization(submissionId: string, attemptId: string, error: unknown): boolean;
}

export interface SqlAgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: SqlAgentSubmissionStore;
}

export class SqlAgentSubmissionConflictError extends Error {}

export class SqlAgentDispatchReceiptRetainedError extends Error {
	constructor(readonly receipt: SqlAgentDispatchReceipt) {
		super('[flue] Internal dispatch replay is already settled.');
	}
}

export function createSqlSessionStore(sql: SqlStorage): SessionStore {
	ensureSessionTable(sql);
	return new SqlSessionStore(sql);
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): SqlAgentExecutionStore {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof sql.exec !== 'function' || typeof transactionSync !== 'function') {
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
		const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
		return {
			sessions,
			submissions: new SqlAgentSubmissionStoreImpl(sql, runTransaction),
		};
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
	constructor(
		private sql: SqlStorage,
		private transactionSync: NonNullable<DurableObjectStorage['transactionSync']>,
	) {}

	getSubmission(submissionId: string): SqlAgentSubmission | null {
		const row = this.readSubmissionRow(submissionId);
		return row ? parseSubmission(row) : null;
	}

	private getDispatchReceipt(submissionId: string): SqlAgentDispatchReceipt | null {
		const row = this.sql
			.exec(
				'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ? LIMIT 1',
				submissionId,
			)
			.toArray()[0];
		if (!row) return null;
		if (typeof row.dispatch_id !== 'string' || typeof row.accepted_at !== 'number') {
			throw new Error('[flue] Persisted dispatch receipt row is malformed.');
		}
		return { submissionId: row.dispatch_id, acceptedAt: row.accepted_at };
	}

	admitDispatch(input: DispatchInput): SqlAgentSubmission {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	admitDirect(input: DirectAgentSubmissionInput): SqlAgentSubmission {
		return this.admitSubmission(input);
	}

	hasUnsettledSubmissions(): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE status IN ('queued', 'running', 'terminalizing')
					 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	listRunnableSubmissions(): SqlAgentSubmission[] {
		const rows = this.sql
			.exec(
				`SELECT ${submissionColumnsFor('current')}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'terminalizing')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseOperationalRows(rows, 'queued');
	}

	listRunningSubmissions(): SqlAgentSubmission[] {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status IN ('running', 'terminalizing')
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'active',
		);
	}

	beginSessionDeletion(sessionKey: string): void {
		this.transactionSync(() => {
			const active = this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing')
					 LIMIT 1`,
					sessionKey,
				)
				.toArray();
			if (active.length > 0) {
				throw new Error(
					'[flue] Session cannot be deleted while durable agent submissions are queued or running. Wait for accepted work to settle, then retry deletion.',
				);
			}
			this.sql.exec(
				'INSERT OR IGNORE INTO flue_agent_session_deletions (session_key, started_at) VALUES (?, ?)',
				sessionKey,
				Date.now(),
			);
		});
	}

	finishSessionDeletion(sessionKey: string): void {
		this.transactionSync(() => {
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at, settled_at)
				 SELECT submission_id, accepted_at, completed_at
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND kind = 'dispatch' AND status IN ('completed', 'error')`,
				sessionKey,
			);
			this.sql.exec(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = ? AND status IN ('completed', 'error')`,
				sessionKey,
			);
			this.sql.exec('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', sessionKey);
		});
	}

	cleanupTerminalSubmissions(completedBefore: number, limit = 100): number {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error('[flue] Terminal submission cleanup limit must be a positive integer.');
		}
		const rows = this.sql
			.exec(
				`SELECT sequence
				 FROM flue_agent_submissions
				 WHERE status IN ('completed', 'error') AND completed_at < ?
				 ORDER BY completed_at ASC, sequence ASC
				 LIMIT ?`,
				completedBefore,
				limit,
			)
			.toArray();
		for (const row of rows) {
			if (typeof row.sequence !== 'number') {
				throw new Error('[flue] Persisted terminal submission row is malformed.');
			}
			this.sql.exec(
				`DELETE FROM flue_agent_submissions
				 WHERE sequence = ? AND status IN ('completed', 'error') AND completed_at < ?`,
				row.sequence,
				completedBefore,
			);
		}
		this.sql.exec('DELETE FROM flue_agent_dispatch_receipts WHERE settled_at < ?', completedBefore);
		return rows.length;
	}

	claimSubmission(submissionId: string, attemptId: string): SqlAgentSubmission | null {
		this.sql.exec(
			`UPDATE flue_agent_submissions AS current
			 SET status = 'running', attempt_id = ?, started_at = ?
			 WHERE current.submission_id = ? AND current.status = 'queued'
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing')
			       AND earlier.sequence < current.sequence
			   )`,
			attemptId,
			Date.now(),
			submissionId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'running' && submission.attemptId === attemptId
			? submission
			: null;
	}

	markSubmissionInputApplied(submissionId: string, attemptId: string): SqlAgentSubmission | null {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			Date.now(),
			submissionId,
			attemptId,
		);
		return this.getOwnedRunningSubmission(submissionId, attemptId);
	}

	requestSubmissionRecovery(submissionId: string, attemptId: string): SqlAgentSubmission | null {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			Date.now(),
			submissionId,
			attemptId,
		);
		return this.getOwnedRunningSubmission(submissionId, attemptId);
	}

	requeueSubmissionBeforeInputApplied(
		submissionId: string,
		attemptId: string,
	): SqlAgentSubmission | null {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL
			 WHERE submission_id = ? AND status = 'running'
			   AND attempt_id = ? AND input_applied_at IS NULL`,
			submissionId,
			attemptId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'queued' ? submission : null;
	}

	beginSubmissionTerminalization(submissionId: string, attemptId: string): SqlAgentSubmission | null {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'terminalizing'
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			submissionId,
			attemptId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'terminalizing' && submission.attemptId === attemptId
			? submission
			: null;
	}

	completeSubmission(submissionId: string, attemptId: string): boolean {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'completed', completed_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			Date.now(),
			submissionId,
			attemptId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'completed' && submission.attemptId === attemptId;
	}

	failSubmission(submissionId: string, attemptId: string, error: unknown): boolean {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'error', completed_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			submissionId,
			attemptId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'error' && submission.attemptId === attemptId;
	}

	finalizeSubmissionTerminalization(submissionId: string, attemptId: string, error: unknown): boolean {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'error', completed_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			submissionId,
			attemptId,
		);
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'error' && submission.attemptId === attemptId;
	}

	private admitSubmission(input: AgentSubmissionInput): SqlAgentSubmission {
		const { kind, submissionId } = input;
		const payload = JSON.stringify(input);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, 'default', input.session);
		return this.transactionSync(() => {
			if (kind === 'dispatch') {
				const receipt = this.getDispatchReceipt(submissionId);
				if (receipt) throw new SqlAgentDispatchReceiptRetainedError(receipt);
			}
			const deleting = this.sql
				.exec('SELECT 1 FROM flue_agent_session_deletions WHERE session_key = ? LIMIT 1', sessionKey)
				.toArray();
			if (deleting.length > 0) {
				throw new Error('[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.');
			}
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_submissions
				 (submission_id, session, session_key, kind, payload, status, accepted_at)
				 VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
				submissionId,
				input.session,
				sessionKey,
				kind,
				payload,
				acceptedAt,
			);
			const row = this.readSubmissionRow(submissionId);
			if (!row) throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind || row.payload !== payload) {
				throw new SqlAgentSubmissionConflictError(`[flue] Conflicting internal ${kind} replay.`);
			}
			return parseSubmission(row);
		});
	}

	private getOwnedRunningSubmission(
		submissionId: string,
		attemptId: string,
	): SqlAgentSubmission | null {
		const submission = this.getSubmission(submissionId);
		return submission?.status === 'running' && submission.attemptId === attemptId
			? submission
			: null;
	}

	private parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
	): SqlAgentSubmission[] {
		const submissions: SqlAgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(parseSubmission(row));
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				this.failSubmissionSequence(row.sequence, status, error);
			}
		}
		return submissions;
	}

	private failSubmissionSequence(sequence: number, status: 'queued' | 'active', error: unknown): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'error', completed_at = ?, error = ?
			 WHERE sequence = ? AND ${status === 'queued' ? "status = 'queued'" : "status IN ('running', 'terminalizing')"}`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			sequence,
		);
	}

	private readSubmissionRow(submissionId: string): SqlRow | undefined {
		return this.sql
			.exec(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE submission_id = ?
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
	}
}

const submissionColumns =
	'sequence, submission_id, session, session_key, kind, payload, status, accepted_at, attempt_id, input_applied_at, recovery_requested_at, started_at, completed_at, error';

function submissionColumnsFor(table: string): string {
	return submissionColumns
		.split(', ')
		.map((column) => `${table}.${column}`)
		.join(', ');
}

function parseSubmission(row: SqlRow): SqlAgentSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'terminalizing' &&
			row.status !== 'completed' &&
			row.status !== 'error') ||
		typeof row.accepted_at !== 'number' ||
		(row.attempt_id !== null && row.attempt_id !== undefined && typeof row.attempt_id !== 'string') ||
		(row.input_applied_at !== null &&
			row.input_applied_at !== undefined &&
			typeof row.input_applied_at !== 'number') ||
		(row.recovery_requested_at !== null &&
			row.recovery_requested_at !== undefined &&
			typeof row.recovery_requested_at !== 'number') ||
		(row.started_at !== null && row.started_at !== undefined && typeof row.started_at !== 'number') ||
		(row.status === 'queued' &&
			(row.attempt_id !== null ||
				row.input_applied_at !== null ||
				row.recovery_requested_at !== null ||
				row.started_at !== null)) ||
		((row.status === 'running' || row.status === 'terminalizing') &&
			(typeof row.attempt_id !== 'string' || typeof row.started_at !== 'number'))
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}
	const input = JSON.parse(row.payload) as unknown;
	if (!isSubmissionPayload(input, row)) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
		session: row.session,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt: row.accepted_at,
		...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
		...(typeof row.input_applied_at === 'number' ? { inputAppliedAt: row.input_applied_at } : {}),
		...(typeof row.recovery_requested_at === 'number'
			? { recoveryRequestedAt: row.recovery_requested_at }
			: {}),
		...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
		...(typeof row.completed_at === 'number' ? { completedAt: row.completed_at } : {}),
		...(typeof row.error === 'string' ? { error: row.error } : {}),
	};
}

function isSubmissionPayload(input: unknown, row: SqlRow): input is AgentSubmissionInput {
	if (!input || typeof input !== 'object') return false;
	const value = input as Partial<AgentSubmissionInput>;
	if (value.kind !== row.kind || value.submissionId !== row.submission_id) return false;
	if (value.kind === 'dispatch') {
		const dispatch = value as Partial<DispatchAgentSubmissionInput>;
		return (
			typeof dispatch.dispatchId === 'string' &&
			dispatch.dispatchId === value.submissionId &&
			typeof dispatch.agent === 'string' &&
			typeof dispatch.id === 'string' &&
			typeof dispatch.session === 'string' &&
			dispatch.session === row.session &&
			createSessionStorageKey(dispatch.id, 'default', dispatch.session) === row.session_key &&
			typeof dispatch.acceptedAt === 'string' &&
			Date.parse(dispatch.acceptedAt) === row.accepted_at &&
			'input' in dispatch &&
			dispatch.input !== undefined
		);
	}
	const direct = value as Partial<DirectAgentSubmissionInput>;
	return (
		typeof direct.agent === 'string' &&
		typeof direct.id === 'string' &&
		typeof direct.session === 'string' &&
		direct.session === row.session &&
		createSessionStorageKey(direct.id, 'default', direct.session) === row.session_key &&
		typeof direct.acceptedAt === 'string' &&
		Date.parse(direct.acceptedAt) === row.accepted_at &&
		isDirectPayload(direct.payload)
	);
}

function isDirectPayload(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const payload = value as { message?: unknown; session?: unknown };
	return (
		typeof payload.message === 'string' &&
		(payload.session === undefined || typeof payload.session === 'string')
	);
}

function parseAcceptedAt(value: string, label: string): number {
	const acceptedAt = Date.parse(value);
	if (!Number.isFinite(acceptedAt)) {
		throw new Error(`[flue] Internal ${label} received an invalid acceptedAt timestamp.`);
	}
	return acceptedAt;
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
		 recovery_requested_at INTEGER,
		 started_at INTEGER,
		 completed_at INTEGER,
		 error TEXT
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_session_deletions (
		 session_key TEXT PRIMARY KEY,
		 started_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
		 dispatch_id TEXT PRIMARY KEY,
		 accepted_at INTEGER NOT NULL,
		 settled_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
}
