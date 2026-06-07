/**
 * Postgres persistence adapter.
 *
 * Implements {@link AgentSubmissionStore} and {@link SessionStore} against a
 * Postgres database using parameterised queries (`$1`, `$2`, ...).
 *
 * The adapter accepts any async SQL runner conforming to {@link PgRunner} so
 * that tests can substitute PGlite without pulling in a real Postgres server.
 */

import type { SessionData, SessionStore } from '@flue/runtime';
import type {
	AgentDispatchAdmission,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	DirectAgentSubmissionInput,
	DispatchInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
} from '@flue/runtime/internal';
import {
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	deduplicateSessionDeletion,
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
} from '@flue/runtime/internal';
import type { DispatchAgentSubmissionInput } from '@flue/runtime/internal';
import pgDriver from 'postgres';

// ─── Generic async SQL runner ───────────────────────────────────────────────

/** A single row returned from a query. */
type SqlRow = Record<string, unknown>;

/**
 * Minimal async SQL execution interface.
 *
 * Both the `postgres` driver and PGlite implement this shape, allowing the
 * store to be tested against an embedded Postgres instance without a server.
 */
export interface PgRunner {
	query(text: string, params?: unknown[]): Promise<SqlRow[]>;
	transaction<T>(fn: (runner: PgRunner) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

// ─── Public factory ─────────────────────────────────────────────────────────

export interface PostgresOptions {
	/**
	 * Connection string (e.g. `postgresql://user:pass@host/db`).
	 * Also accepts the options object form supported by the `postgres` driver.
	 */
	connectionString?: string;
	/** Override the default `postgres` driver options. */
	driverOptions?: Record<string, unknown>;
}

/**
 * Create a Postgres-backed {@link PersistenceAdapter}.
 *
 * @example
 * ```ts
 * import { postgres } from '@flue/postgres';
 * export default postgres('postgresql://localhost/mydb');
 * ```
 */
export function postgres(urlOrOptions?: string | PostgresOptions): PersistenceAdapter {
	let runner: PgRunner | undefined;

	function getRunner(): PgRunner {
		if (!runner) {
			const opts = typeof urlOrOptions === 'string' ? { connectionString: urlOrOptions } : (urlOrOptions ?? {});
			runner = createPgDriverRunner(opts);
		}
		return runner;
	}

	return {
		async migrate() {
			await ensureTables(getRunner());
		},
		connect() {
			const r = getRunner();
			return {
				sessions: new PgSessionStore(r),
				submissions: new PgSubmissionStore(r),
			};
		},
		async close() {
			await runner?.close();
			runner = undefined;
		},
	};
}

/**
 * Create a {@link PersistenceAdapter} from a pre-built {@link PgRunner}.
 * Used internally for testing with PGlite.
 */
export function postgresFromRunner(runner: PgRunner): PersistenceAdapter {
	let closed = false;
	return {
		async migrate() {
			await ensureTables(runner);
		},
		connect() {
			return {
				sessions: new PgSessionStore(runner),
				submissions: new PgSubmissionStore(runner),
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			await runner.close();
		},
	};
}

// ─── Driver adapter ─────────────────────────────────────────────────────────

function createPgDriverRunner(opts: PostgresOptions): PgRunner {
	const sql = opts.connectionString
		? pgDriver(opts.connectionString, opts.driverOptions as never)
		: pgDriver(opts.driverOptions as never);

	return {
		async query(text: string, params: unknown[] = []) {
			// The `postgres` driver uses tagged template literals for safe
			// parameterisation. `sql.unsafe()` accepts a raw query string with
			// numbered `$N` placeholders — which is exactly what we build.
			const result = await sql.unsafe(text, params as never[]);
			return result as unknown as SqlRow[];
		},
		async transaction<T>(fn: (tx: PgRunner) => Promise<T>): Promise<T> {
			return sql.begin(async (txSql) => {
				const txRunner: PgRunner = {
					async query(text: string, params: unknown[] = []) {
						const result = await txSql.unsafe(text, params as never[]);
						return result as unknown as SqlRow[];
					},
					transaction: () => {
						throw new Error('[flue] Nested transactions are not supported.');
					},
					close: () => Promise.resolve(),
				};
				return fn(txRunner);
			}) as Promise<T>;
		},
		async close() {
			await sql.end();
		},
	};
}

// ─── Schema ─────────────────────────────────────────────────────────────────

async function ensureTables(runner: PgRunner): Promise<void> {
	// Postgres DDL is transactional — wrap all schema setup in a single
	// transaction so partial failures don't leave the database half-migrated.
	await runner.transaction(async (tx) => {
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_sessions (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at BIGINT NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_submissions (
				sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				submission_id TEXT NOT NULL UNIQUE,
				session_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				accepted_at BIGINT NOT NULL,
				attempt_id TEXT,
				input_applied_at BIGINT,
				recovery_requested_at BIGINT,
				started_at BIGINT,
				settled_at BIGINT,
				error TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_RETRY},
				timeout_at BIGINT NOT NULL DEFAULT 0
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_turn_journals (
				submission_id TEXT PRIMARY KEY,
				session_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				phase TEXT NOT NULL,
				revision INTEGER NOT NULL,
				created_at BIGINT NOT NULL,
				updated_at BIGINT NOT NULL,
				checkpoint_leaf_id TEXT,
				tool_request_json TEXT,
				stream_key TEXT,
				stream_consumed_at BIGINT,
				committed INTEGER NOT NULL DEFAULT 0,
				committed_leaf_id TEXT
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_stream_chunks (
				stream_key TEXT NOT NULL,
				segment_index INTEGER NOT NULL,
				body TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				PRIMARY KEY (stream_key, segment_index)
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_session_deletions (
				session_key TEXT PRIMARY KEY,
				started_at BIGINT NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
				dispatch_id TEXT PRIMARY KEY,
				accepted_at BIGINT NOT NULL,
				settled_at BIGINT NOT NULL
			)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx
			ON flue_agent_submissions (status, sequence ASC)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx
			ON flue_agent_submissions (session_key, status, sequence ASC)
		`);
	});
}

// ─── Session store ──────────────────────────────────────────────────────────

class PgSessionStore implements SessionStore {
	constructor(private runner: PgRunner) {}

	async save(id: string, data: SessionData): Promise<void> {
		await this.runner.query(
			`INSERT INTO flue_sessions (id, data, updated_at) VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
			[id, JSON.stringify(data), Date.now()],
		);
	}

	async load(id: string): Promise<SessionData | null> {
		const rows = await this.runner.query('SELECT data FROM flue_sessions WHERE id = $1 LIMIT 1', [id]);
		const row = rows[0];
		if (!row) return null;
		if (typeof row.data !== 'string') throw new Error('[flue] Persisted session row is malformed.');
		return JSON.parse(row.data) as SessionData;
	}

	async delete(id: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_sessions WHERE id = $1', [id]);
	}
}

// ─── Submission store ───────────────────────────────────────────────────────

const submissionColumns = [
	'sequence', 'submission_id', 'session_key', 'kind', 'payload', 'status',
	'accepted_at', 'attempt_id', 'input_applied_at', 'recovery_requested_at',
	'started_at', 'error', 'attempt_count', 'max_retry', 'timeout_at',
].join(', ');

function prefixed(table: string): string {
	return submissionColumns.split(', ').map((c) => `${table}.${c}`).join(', ');
}

class PgSubmissionStore implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(private runner: PgRunner) {}

	// ── Query ────────────────────────────────────────────────────────────

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const rows = await this.runner.query(
			`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = $1 LIMIT 1`,
			[submissionId],
		);
		return rows[0] ? parseSubmission(rows[0]) : null;
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const rows = await this.runner.query(
			`SELECT submission_id, session_key, kind, attempt_id, operation_id, turn_id,
			        phase, revision, created_at, updated_at, checkpoint_leaf_id,
			        tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id
			 FROM flue_agent_turn_journals
			 WHERE submission_id = $1
			 LIMIT 1`,
			[submissionId],
		);
		return rows[0] ? parseTurnJournal(rows[0]) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		const rows = await this.runner.query(
			`SELECT 1 FROM flue_agent_submissions WHERE status IN ('queued', 'running') LIMIT 1`,
		);
		return rows.length > 0;
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.runner.query(
			`SELECT ${prefixed('current_sub')}
			 FROM flue_agent_submissions AS current_sub
			 WHERE current_sub.status = 'queued'
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current_sub.session_key
			       AND earlier.status IN ('queued', 'running')
			       AND earlier.sequence < current_sub.sequence
			   )
			 ORDER BY current_sub.sequence ASC`,
		);
		return this.parseOperationalRows(rows, 'queued');
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.runner.query(
			`SELECT ${submissionColumns}
			 FROM flue_agent_submissions
			 WHERE status = 'running'
			 ORDER BY sequence ASC`,
		);
		return this.parseOperationalRows(rows, 'active');
	}

	// ── Turn journal lifecycle ───────────────────────────────────────────

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		const toolRequestJson = input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest);
		const rows = await this.runner.query(
			`INSERT INTO flue_agent_turn_journals
			 (submission_id, session_key, kind, attempt_id, operation_id, turn_id,
			  phase, revision, created_at, updated_at, checkpoint_leaf_id,
			  tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, NULL, NULL, 0, NULL)
			 ON CONFLICT (submission_id) DO UPDATE SET
			   attempt_id = EXCLUDED.attempt_id,
			   operation_id = EXCLUDED.operation_id,
			   turn_id = EXCLUDED.turn_id,
			   phase = EXCLUDED.phase,
			   revision = flue_agent_turn_journals.revision + 1,
			   updated_at = EXCLUDED.updated_at,
			   checkpoint_leaf_id = EXCLUDED.checkpoint_leaf_id,
			   tool_request_json = EXCLUDED.tool_request_json,
			   stream_key = NULL,
			   stream_consumed_at = NULL,
			   committed = 0,
			   committed_leaf_id = NULL
			 RETURNING submission_id`,
			[
				input.submissionId, input.sessionKey, input.kind, input.attemptId,
				input.operationId, input.turnId, input.phase, now, now,
				input.checkpointLeafId ?? null, toolRequestJson,
			],
		);
		return rows.length > 0;
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown; streamKey?: string } = {},
	): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_turn_journals
			 SET phase = $1, revision = revision + 1, updated_at = $2,
			     checkpoint_leaf_id = COALESCE($3, checkpoint_leaf_id),
			     tool_request_json = COALESCE($4, tool_request_json),
			     stream_key = COALESCE($5, stream_key)
			 WHERE submission_id = $6 AND attempt_id = $7 AND committed = 0
			 RETURNING submission_id`,
			[
				phase, now,
				options.checkpointLeafId ?? null,
				options.toolRequest === undefined ? null : JSON.stringify(options.toolRequest),
				options.streamKey ?? null,
				attempt.submissionId, attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	async commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_turn_journals
			 SET phase = 'committed', revision = revision + 1, updated_at = $1,
			     committed = 1, committed_leaf_id = $2
			 WHERE submission_id = $3 AND attempt_id = $4 AND committed = 0
			 RETURNING submission_id`,
			[now, committedLeafId, attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_turn_journals
			 SET revision = revision + 1, updated_at = $1, stream_consumed_at = $2
			 WHERE submission_id = $3 AND attempt_id = $4 AND committed = 0
			   AND stream_key = $5 AND stream_consumed_at IS NULL
			 RETURNING submission_id`,
			[now, now, attempt.submissionId, attempt.attemptId, streamKey],
		);
		return rows.length > 0;
	}

	async appendStreamChunkSegment(streamKey: string, segmentIndex: number, body: string): Promise<boolean> {
		const rows = await this.runner.query(
			`INSERT INTO flue_agent_stream_chunks (stream_key, segment_index, body, created_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (stream_key, segment_index) DO NOTHING
			 RETURNING stream_key`,
			[streamKey, segmentIndex, body, Date.now()],
		);
		return rows.length > 0;
	}

	async getStreamChunkSegments(streamKey: string): Promise<Array<{ segmentIndex: number; body: string }>> {
		const rows = await this.runner.query(
			`SELECT segment_index, body
			 FROM flue_agent_stream_chunks
			 WHERE stream_key = $1
			 ORDER BY segment_index ASC`,
			[streamKey],
		);
		return rows.map((row) => ({ segmentIndex: Number(row.segment_index), body: String(row.body) }));
	}

	async deleteStreamChunkSegments(streamKey: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_agent_stream_chunks WHERE stream_key = $1', [streamKey]);
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
	): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const now = Date.now();
			const subRows = await tx.query(
				`UPDATE flue_agent_submissions
				 SET attempt_id = $1, recovery_requested_at = NULL, started_at = $2, attempt_count = attempt_count + 1
				 WHERE submission_id = $3 AND status = 'running' AND attempt_id = $4
				 RETURNING ${submissionColumns}`,
				[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
			);
			if (!subRows[0]) return null;
			await tx.query(
				`UPDATE flue_agent_turn_journals
				 SET attempt_id = $1, revision = revision + 1, updated_at = $2
				 WHERE submission_id = $3 AND attempt_id = $4 AND committed = 0`,
				[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
			);
			return parseSubmission(subRows[0]);
		});
	}

	// ── Admission ────────────────────────────────────────────────────────

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
		const admission = await this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	// ── Submission lifecycle ─────────────────────────────────────────────

	async claimSubmission(attempt: SubmissionAttemptRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MINUTES * 60_000;

		// Postgres does not support `UPDATE ... AS alias` with a self-referencing
		// NOT EXISTS subquery the way SQLite does. Use a CTE to identify the
		// candidate, then update by primary key. The RETURNING clause must
		// qualify column names to avoid ambiguity with the CTE join.
		const rows = await this.runner.query(
			`WITH candidate AS (
			   SELECT s.sequence FROM flue_agent_submissions s
			   WHERE s.submission_id = $5 AND s.status = 'queued'
			     AND NOT EXISTS (
			       SELECT 1 FROM flue_agent_submissions earlier
			       WHERE earlier.session_key = s.session_key
			         AND earlier.status IN ('queued', 'running')
			         AND earlier.sequence < s.sequence
			     )
			 )
			 UPDATE flue_agent_submissions
			 SET status = 'running', attempt_id = $1, started_at = $2, attempt_count = 1,
			     max_retry = $3, timeout_at = $4
			 FROM candidate
			 WHERE flue_agent_submissions.sequence = candidate.sequence
			 RETURNING ${prefixed('flue_agent_submissions')}`,
			[attempt.attemptId, now, DURABILITY_DEFAULT_MAX_RETRY, timeoutAt, attempt.submissionId],
		);
		return rows[0] ? parseSubmission(rows[0]) : null;
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, $1),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN $2 ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN $3 ELSE timeout_at END
			 WHERE submission_id = $4 AND status = 'running' AND attempt_id = $5
			 RETURNING submission_id`,
			[
				now,
				durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_RETRY,
				durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MINUTES * 60_000,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, $1)
			 WHERE submission_id = $2 AND status = 'running' AND attempt_id = $3
			 RETURNING submission_id`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL
			 WHERE submission_id = $1 AND status = 'running'
			   AND attempt_id = $2 AND input_applied_at IS NULL
			 RETURNING submission_id`,
			[attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = $1, error = NULL
			 WHERE submission_id = $2 AND status = 'running' AND attempt_id = $3
			 RETURNING submission_id`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = $1, error = $2
			 WHERE submission_id = $3 AND status = 'running' AND attempt_id = $4
			 RETURNING submission_id`,
			[
				Date.now(),
				error instanceof Error ? error.message : String(error),
				attempt.submissionId, attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	// ── Deletion ─────────────────────────────────────────────────────────

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pendingSessionDeletions, sessionKey, () =>
			this.runSessionDeletion(sessionKey, deleteSessionTree),
		);
	}

	// ── Private ──────────────────────────────────────────────────────────

	private async admitSubmission(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
		const { kind, submissionId } = input;
		const payload = JSON.stringify(input);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, SUBMISSION_HARNESS_NAME, input.session);

		return this.runner.transaction(async (tx) => {
			if (kind === 'dispatch') {
				const receiptRows = await tx.query(
					'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = $1 LIMIT 1',
					[submissionId],
				);
				if (receiptRows[0]) {
					const r = receiptRows[0];
					return {
						kind: 'retained_receipt' as const,
						receipt: {
							submissionId: r.dispatch_id as string,
							acceptedAt: Number(r.accepted_at),
						},
					};
				}
			}

			const deletingRows = await tx.query(
				'SELECT 1 FROM flue_agent_session_deletions WHERE session_key = $1 LIMIT 1',
				[sessionKey],
			);
			if (deletingRows.length > 0) {
				throw new Error(
					'[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.',
				);
			}

			await tx.query(
				`INSERT INTO flue_agent_submissions
				 (submission_id, session_key, kind, payload, status, accepted_at)
				 VALUES ($1, $2, $3, $4, 'queued', $5)
				 ON CONFLICT (submission_id) DO NOTHING`,
				[submissionId, sessionKey, kind, payload, acceptedAt],
			);

			const readRows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = $1 LIMIT 1`,
				[submissionId],
			);
			const row = readRows[0];
			if (!row) throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind || row.payload !== payload) return { kind: 'conflict' as const };
			return { kind: 'submission' as const, submission: parseSubmission(row) };
		});
	}

	private async runSessionDeletion(
		sessionKey: string,
		deleteSessionTree: () => Promise<void>,
	): Promise<void> {
		// Phase 1: check for active submissions and mark deletion.
		const deletionStartedAt = Date.now();
		await this.runner.transaction(async (tx) => {
			const active = await tx.query(
				`SELECT 1 FROM flue_agent_submissions
				 WHERE session_key = $1 AND status IN ('queued', 'running') LIMIT 1`,
				[sessionKey],
			);
			if (active.length > 0) {
				throw new Error(
					'[flue] Session cannot be deleted while durable agent submissions are queued or running. Wait for accepted work to settle, then retry deletion.',
				);
			}
			await tx.query(
				`INSERT INTO flue_agent_session_deletions (session_key, started_at) VALUES ($1, $2)
				 ON CONFLICT (session_key) DO NOTHING`,
				[sessionKey, deletionStartedAt],
			);
		});

		// Phase 2: delete the session tree (async, outside transaction).
		await deleteSessionTree();

		// Phase 3: clean up settled submission rows and deletion marker.
		// Scope to submissions accepted before deletion started to avoid racing
		// with submissions admitted and settled during the async phase 2 gap.
		await this.runner.transaction(async (tx) => {
			await tx.query(
				`INSERT INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at, settled_at)
				 SELECT submission_id, accepted_at, COALESCE(settled_at, accepted_at)
				 FROM flue_agent_submissions
				 WHERE session_key = $1 AND kind = 'dispatch' AND status = 'settled'
				   AND accepted_at <= $2
				 ON CONFLICT (dispatch_id) DO NOTHING`,
				[sessionKey, deletionStartedAt],
			);
			await tx.query(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = $1 AND status = 'settled' AND accepted_at <= $2`,
				[sessionKey, deletionStartedAt],
			);
			await tx.query('DELETE FROM flue_agent_session_deletions WHERE session_key = $1', [sessionKey]);
		});
	}

	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(parseSubmission(row));
			} catch (error) {
				const seq = Number(row.sequence);
				if (!Number.isFinite(seq)) throw error;
				await this.failSubmissionSequence(seq, status, error);
			}
		}
		return submissions;
	}

	private async failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
	): Promise<void> {
		const statusFilter = status === 'queued' ? "status = 'queued'" : "status = 'running'";
		await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = $1, error = $2
			 WHERE sequence = $3 AND ${statusFilter}`,
			[Date.now(), error instanceof Error ? error.message : String(error), sequence],
		);
	}
}

// ─── Row parsers ────────────────────────────────────────────────────────────
// Intentionally adapter-specific: each backend has its own column types,
// coercion rules (e.g. Postgres BIGINT → string), and storage representation.

function parseSubmission(row: SqlRow): AgentSubmission {
	// Postgres returns BIGINT as string; coerce to number.
	const sequence = Number(row.sequence);
	const acceptedAt = Number(row.accepted_at);
	const attemptCount = Number(row.attempt_count);
	const maxRetry = Number(row.max_retry);
	const timeoutAt = Number(row.timeout_at);

	const attemptId = row.attempt_id != null ? String(row.attempt_id) : undefined;
	const inputAppliedAt = row.input_applied_at != null ? Number(row.input_applied_at) : undefined;
	const recoveryRequestedAt = row.recovery_requested_at != null ? Number(row.recovery_requested_at) : undefined;
	const startedAt = row.started_at != null ? Number(row.started_at) : undefined;

	if (
		!Number.isFinite(sequence) ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' && row.status !== 'running' && row.status !== 'settled') ||
		!Number.isFinite(acceptedAt) ||
		// Status-specific invariants: queued rows must not have running fields,
		// running rows must have attemptId and startedAt.
		(row.status === 'queued' &&
			(attemptId !== undefined || inputAppliedAt !== undefined ||
			 recoveryRequestedAt !== undefined || startedAt !== undefined)) ||
		(row.status === 'running' &&
			(attemptId === undefined || startedAt === undefined)) ||
		!Number.isFinite(attemptCount) ||
		!Number.isFinite(maxRetry) ||
		!Number.isFinite(timeoutAt)
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}

	const input = JSON.parse(row.payload) as unknown;
	if (!isSubmissionPayload(input, {
		kind: row.kind as string,
		submissionId: row.submission_id as string,
		sessionKey: row.session_key as string,
		acceptedAt,
	})) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}

	const error = row.error != null ? String(row.error) : undefined;

	return {
		sequence,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt,
		...(attemptId !== undefined ? { attemptId } : {}),
		...(inputAppliedAt !== undefined ? { inputAppliedAt } : {}),
		...(recoveryRequestedAt !== undefined ? { recoveryRequestedAt } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(error !== undefined ? { error } : {}),
		attemptCount,
		maxRetry,
		timeoutAt,
	};
}

function parseTurnJournal(row: SqlRow): AgentTurnJournal {
	const revision = Number(row.revision);
	const createdAt = Number(row.created_at);
	const updatedAt = Number(row.updated_at);
	const committed = Number(row.committed);

	if (
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.attempt_id !== 'string' ||
		typeof row.operation_id !== 'string' ||
		typeof row.turn_id !== 'string' ||
		(row.phase !== 'before_provider' &&
			row.phase !== 'provider_started' &&
			row.phase !== 'tool_request_recorded' &&
			row.phase !== 'committed') ||
		!Number.isFinite(revision) ||
		!Number.isFinite(createdAt) ||
		!Number.isFinite(updatedAt) ||
		(committed !== 0 && committed !== 1)
	) {
		throw new Error('[flue] Persisted turn journal row is malformed.');
	}

	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		attemptId: row.attempt_id,
		operationId: row.operation_id,
		turnId: row.turn_id,
		phase: row.phase,
		revision,
		createdAt,
		updatedAt,
		...(row.checkpoint_leaf_id != null ? { checkpointLeafId: String(row.checkpoint_leaf_id) } : {}),
		...(typeof row.tool_request_json === 'string' ? { toolRequest: JSON.parse(row.tool_request_json) as unknown } : {}),
		...(typeof row.stream_key === 'string' ? { streamKey: row.stream_key } : {}),
		...(row.stream_consumed_at != null ? { streamConsumedAt: Number(row.stream_consumed_at) } : {}),
		committed: committed === 1,
		...(row.committed_leaf_id != null ? { committedLeafId: String(row.committed_leaf_id) } : {}),
	};
}


