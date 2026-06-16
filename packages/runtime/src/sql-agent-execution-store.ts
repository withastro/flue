/**
 * Shared SQL agent execution store implementation.
 *
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`). Contains all
 * SQL-level storage logic — table DDL, row parsing, and the
 * {@link AgentSubmissionStore} and {@link SessionStore} implementations.
 *
 * Platform-specific wiring (opening the database, providing a transaction
 * wrapper) lives in `cloudflare/agent-execution-store.ts` and
 * `node/agent-execution-store.ts`.
 *
 * INTERNAL convenience, scoped to the SQLite dialect family (`node:sqlite`
 * and Durable Object SQLite). Do NOT generalize this module across SQL
 * dialects: there is deliberately no generic-SQL abstraction spanning
 * SQLite and Postgres, and `@flue/postgres` implements the store contract
 * directly on purpose. Cross-backend parity is enforced by the documented
 * invariants on the store interfaces and the contract suites in
 * `@flue/runtime/test-utils`, not by code sharing.
 */

import {
	deduplicateSessionDeletion,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from './adapter-helpers.ts';
import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from './agent-execution-store.ts';
import {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';
import type { SqlStorage } from './sql-storage.ts';

type SqlRow = Record<string, unknown>;

import {
	hydratePersistedDirectSubmission,
	hydratePersistedSessionEntry,
	matchesPersistedDirectSubmission,
	prepareDirectSubmission,
	prepareSessionEntry,
	samePersistedChunks,
	sessionEntryChunkOwner,
	submissionChunkOwner,
} from './persisted-image-placement.ts';
import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { ensureFlueSchemaVersion } from './schema-version.ts';
import { createSessionStorageKey } from './session-identity.ts';
import {
	createSqlPersistedChunkStore,
	ensureSqlPersistedChunkTable,
} from './sql-persisted-chunk-store.ts';
import type { SessionData, SessionEntry, SessionStore } from './types.ts';

/**
 * Bring the agent execution store schema to the current version.
 * Called by `createSqlAgentExecutionStore` (Cloudflare DO path) and
 * by the `sqlite()` adapter's `migrate()` method (Node).
 *
 * Stamps a fresh database with the current schema version and throws when
 * the database records an unknown or newer version, then runs idempotent DDL.
 */
export function ensureSqlAgentExecutionTables(sql: SqlStorage): void {
	ensureFlueSchemaVersion(sql);
	ensureSessionTable(sql);
	ensureSubmissionTable(sql);
	ensureTurnJournalTable(sql);
	ensureSqlPersistedChunkTable(sql);
}

/**
 * Initialize an {@link AgentExecutionStore} from raw SQL primitives.
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`).
 *
 * **Does not run DDL.** Call {@link ensureSqlAgentExecutionTables} first
 * to ensure the schema exists.
 */
export function createSqlAgentExecutionStoreFromSql(
	sql: SqlStorage,
	runTransaction: <T>(closure: () => T) => T,
): AgentExecutionStore {
	return {
		sessions: new SqlSessionStore(sql, runTransaction),
		submissions: new AgentSubmissionStoreImpl(sql, runTransaction),
	};
}

export class SqlSessionStore implements SessionStore {
	constructor(
		private sql: SqlStorage,
		private transactionSync: <T>(closure: () => T) => T,
	) {}

	async save(id: string, data: SessionData): Promise<void> {
		const { entries: sessionEntries, ...session } = data;
		const entries = sessionEntries.map((entry, position) => {
			const prepared = prepareSessionEntry(entry);
			return { entry, position, data: JSON.stringify(prepared.value), chunks: prepared.chunks };
		});
		this.transactionSync(() => {
			const chunkStore = createSqlPersistedChunkStore(this.sql);
			this.sql.exec(
				`INSERT INTO flue_sessions (id, data) VALUES (?, ?)
				 ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
				id,
				JSON.stringify(session),
			);
			const existingRows = this.sql
				.exec('SELECT entry_id, position, data FROM flue_session_entries WHERE session_id = ?', id)
				.toArray();
			const existing = new Map(existingRows.map((row) => [row.entry_id, row]));
			const retained = new Set<string>();
			for (const { entry, position, data: entryData, chunks } of entries) {
				retained.add(entry.id);
				const current = existing.get(entry.id);
				const owner = sessionEntryChunkOwner(id, entry.id);
				const currentChunks = chunkStore.read(owner);
				const entryChanged = current?.position !== position || current.data !== entryData;
				const chunksChanged = !samePersistedChunks(currentChunks, chunks);
				if (!entryChanged && !chunksChanged) continue;
				if (entryChanged) {
					this.sql.exec(
						`INSERT INTO flue_session_entries (session_id, entry_id, position, data)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT (session_id, entry_id) DO UPDATE SET
						 position = excluded.position, data = excluded.data`,
						id,
						entry.id,
						position,
						entryData,
					);
				}
				if (chunksChanged) chunkStore.replace(owner, chunks);
			}
			for (const row of existingRows) {
				if (typeof row.entry_id === 'string' && !retained.has(row.entry_id)) {
					chunkStore.delete(sessionEntryChunkOwner(id, row.entry_id));
					this.sql.exec(
						'DELETE FROM flue_session_entries WHERE session_id = ? AND entry_id = ?',
						id,
						row.entry_id,
					);
				}
			}
		});
	}

	async load(id: string): Promise<SessionData | null> {
		return this.transactionSync(() => {
			const chunkStore = createSqlPersistedChunkStore(this.sql);
			const rows = this.sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
			const row = rows[0];
			if (!row) return null;
			if (typeof row.data !== 'string') {
				throw new Error('[flue] Persisted session row is malformed.');
			}
			const session = JSON.parse(row.data) as Omit<SessionData, 'entries'>;
			const entryRows = this.sql
				.exec(
					'SELECT entry_id, data FROM flue_session_entries WHERE session_id = ? ORDER BY position ASC',
					id,
				)
				.toArray();
			return {
				...session,
				entries: entryRows.map((entryRow) => {
					if (typeof entryRow.entry_id !== 'string' || typeof entryRow.data !== 'string') {
						throw new Error('[flue] Persisted session entry row is malformed.');
					}
					return hydratePersistedSessionEntry(
						JSON.parse(entryRow.data) as SessionEntry,
						chunkStore.read(sessionEntryChunkOwner(id, entryRow.entry_id)),
					);
				}),
			};
		});
	}

	async delete(id: string): Promise<void> {
		this.transactionSync(() => {
			createSqlPersistedChunkStore(this.sql).deleteOwner('session_entry', id);
			this.sql.exec('DELETE FROM flue_session_entries WHERE session_id = ?', id);
			this.sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
		});
	}
}

class AgentSubmissionStoreImpl implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(
		private sql: SqlStorage,
		private transactionSync: <T>(closure: () => T) => T,
	) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.readSubmissionRow(submissionId);
		return row ? this.parseSubmission(row) : null;
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const row = this.sql
			.exec(
				`SELECT submission_id, session_key, kind, attempt_id, operation_id, turn_id,
					        phase, revision, created_at, updated_at, checkpoint_leaf_id,
					        tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id
				 FROM flue_agent_turn_journals
				 WHERE submission_id = ?
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
		return row ? parseTurnJournal(row) : null;
	}

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`INSERT INTO flue_agent_turn_journals
					 (submission_id, session_key, kind, attempt_id, operation_id, turn_id,
						  phase, revision, created_at, updated_at, checkpoint_leaf_id,
						  tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id)
							 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, NULL)
						 ON CONFLICT(submission_id) DO UPDATE SET
						  attempt_id = excluded.attempt_id,
						  operation_id = excluded.operation_id,
						  turn_id = excluded.turn_id,
						  phase = excluded.phase,
						  revision = flue_agent_turn_journals.revision + 1,
						  updated_at = excluded.updated_at,
						  checkpoint_leaf_id = excluded.checkpoint_leaf_id,
						  tool_request_json = excluded.tool_request_json,
						  stream_key = NULL,
						  stream_consumed_at = NULL,
						  committed = 0,
						  committed_leaf_id = NULL
						 RETURNING submission_id`,
					input.submissionId,
					input.sessionKey,
					input.kind,
					input.attemptId,
					input.operationId,
					input.turnId,
					input.phase,
					now,
					now,
					input.checkpointLeafId ?? null,
					input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest),
				)
				.toArray().length > 0
		);
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown; streamKey?: string } = {},
	): Promise<boolean> {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_turn_journals
					 SET phase = ?, revision = revision + 1, updated_at = ?,
						     checkpoint_leaf_id = COALESCE(?, checkpoint_leaf_id),
						     tool_request_json = COALESCE(?, tool_request_json),
						     stream_key = COALESCE(?, stream_key)
					 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
					 RETURNING submission_id`,
					phase,
					now,
					options.checkpointLeafId ?? null,
					options.toolRequest === undefined ? null : JSON.stringify(options.toolRequest),
					options.streamKey ?? null,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	async commitTurnJournal(
		attempt: SubmissionAttemptRef,
		committedLeafId: string,
	): Promise<boolean> {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_turn_journals
					 SET phase = 'committed', revision = revision + 1, updated_at = ?,
					     committed = 1, committed_leaf_id = ?
					 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
					 RETURNING submission_id`,
					now,
					committedLeafId,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	async markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean> {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_turn_journals
					 SET revision = revision + 1, updated_at = ?, stream_consumed_at = ?
					 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
					   AND stream_key = ? AND stream_consumed_at IS NULL
					 RETURNING submission_id`,
					now,
					now,
					attempt.submissionId,
					attempt.attemptId,
					streamKey,
				)
				.toArray().length > 0
		);
	}

	async appendStreamChunkSegment(
		streamKey: string,
		segmentIndex: number,
		body: string,
	): Promise<boolean> {
		return (
			this.sql
				.exec(
					`INSERT OR IGNORE INTO flue_agent_stream_chunks
					 (stream_key, segment_index, body)
					 VALUES (?, ?, ?)
					 RETURNING stream_key`,
					streamKey,
					segmentIndex,
					body,
				)
				.toArray().length > 0
		);
	}

	async getStreamChunkSegments(
		streamKey: string,
	): Promise<Array<{ segmentIndex: number; body: string }>> {
		const rows = this.sql
			.exec(
				`SELECT segment_index, body
				 FROM flue_agent_stream_chunks
				 WHERE stream_key = ?
				 ORDER BY segment_index ASC`,
				streamKey,
			)
			.toArray();
		return rows.map((row) => {
			if (typeof row.segment_index !== 'number' || typeof row.body !== 'string') {
				throw new Error('[flue] Persisted stream chunk row is malformed.');
			}
			return { segmentIndex: row.segment_index, body: row.body };
		});
	}

	async deleteStreamChunkSegments(streamKey: string): Promise<void> {
		this.sql.exec('DELETE FROM flue_agent_stream_chunks WHERE stream_key = ?', streamKey);
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		return this.transactionSync(() => {
			const now = Date.now();
			const row = this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1${
							lease ? ', owner_id = ?, lease_expires_at = ?' : ''
						}
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING ${submissionColumns}`,
					...(lease
						? [
								nextAttemptId,
								now,
								lease.ownerId,
								lease.leaseExpiresAt,
								attempt.submissionId,
								attempt.attemptId,
							]
						: [nextAttemptId, now, attempt.submissionId, attempt.attemptId]),
				)
				.toArray()[0];
			if (!row) return null;
			this.sql.exec(
				`UPDATE flue_agent_turn_journals
				 SET attempt_id = ?, revision = revision + 1, updated_at = ?
				 WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
				nextAttemptId,
				now,
				attempt.submissionId,
				attempt.attemptId,
			);
			return this.parseSubmission(row);
		});
	}

	private getDispatchReceipt(submissionId: string): AgentDispatchReceipt | null {
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

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
		const admission = this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
				 WHERE status IN ('queued', 'running')
				 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = this.sql
			.exec(
				`SELECT ${submissionColumnsFor('current')}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseOperationalRows(rows, 'queued');
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running'
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'active',
		);
	}

	// ── Attempt markers ──────────────────────────────────────────────────

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES (?, ?, ?)`,
			attempt.submissionId,
			attempt.attemptId,
			Date.now(),
		);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		this.sql.exec(
			'DELETE FROM flue_agent_attempt_markers WHERE submission_id = ? AND attempt_id = ?',
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const rows = this.sql
			.exec('SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers')
			.toArray();
		return rows.map((row) => {
			if (
				typeof row.submission_id !== 'string' ||
				typeof row.attempt_id !== 'string' ||
				typeof row.created_at !== 'number'
			) {
				throw new Error('[flue] Persisted attempt marker row is malformed.');
			}
			return {
				submissionId: row.submission_id,
				attemptId: row.attempt_id,
				createdAt: row.created_at,
			};
		});
	}

	// ── Lease management ────────────────────────────────────────────────

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		const now = Date.now();
		const leaseExpiresAt = now + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => '?').join(', ');
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`,
			leaseExpiresAt,
			ownerId,
			...submissionIds,
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const now = Date.now();
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
					 ORDER BY sequence ASC`,
					now,
				)
				.toArray(),
			'active',
		);
	}

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pendingSessionDeletions, sessionKey, () =>
			this.runSessionDeletion(sessionKey, deleteSessionTree),
		);
	}

	async listPendingSessionDeletions(): Promise<string[]> {
		return this.sql
			.exec('SELECT session_key FROM flue_agent_session_deletions')
			.toArray()
			.map((row) => String(row.session_key));
	}

	private async runSessionDeletion(
		sessionKey: string,
		deleteSessionTree: () => Promise<void>,
	): Promise<void> {
		this.transactionSync(() => {
			const active = this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE session_key = ? AND status IN ('queued', 'running')
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
		try {
			await deleteSessionTree();
		} catch (error) {
			// Remove the deletion marker so the session returns to a usable
			// state. A persistent deleteSessionTree failure must not leave the
			// marker indefinitely blocking future admissions.
			this.sql.exec('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', sessionKey);
			throw error;
		}
		this.transactionSync(() => {
			const deletionRows = this.sql
				.exec(
					'SELECT started_at FROM flue_agent_session_deletions WHERE session_key = ?',
					sessionKey,
				)
				.toArray();
			const deletionRow = deletionRows[0];
			if (!deletionRow || typeof deletionRow.started_at !== 'number') {
				// The marker is gone: a concurrent deletion run (e.g. a startup
				// resume in another process sharing this database) already
				// completed phase 3. Nothing left to clean up.
				return;
			}
			const startedAt = deletionRow.started_at;
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at)
				 SELECT submission_id, accepted_at
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND kind = 'dispatch' AND status = 'settled' AND accepted_at <= ?`,
				sessionKey,
				startedAt,
			);
			// Clean up orphaned stream chunks for journals belonging to deleted submissions.
			this.sql.exec(
				`DELETE FROM flue_agent_stream_chunks
				 WHERE stream_key IN (
				   SELECT j.stream_key FROM flue_agent_turn_journals j
				   INNER JOIN flue_agent_submissions s ON j.submission_id = s.submission_id
				   WHERE s.session_key = ? AND s.status = 'settled' AND s.accepted_at <= ?
				     AND j.stream_key IS NOT NULL
				 )`,
				sessionKey,
				startedAt,
			);
			// Clean up orphaned turn journals for deleted submissions.
			this.sql.exec(
				`DELETE FROM flue_agent_turn_journals
				 WHERE submission_id IN (
				   SELECT submission_id FROM flue_agent_submissions
				   WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?
				 )`,
				sessionKey,
				startedAt,
			);
			const deletedSubmissionRows = this.sql
				.exec(
					`SELECT submission_id FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?`,
					sessionKey,
					startedAt,
				)
				.toArray();
			const submissionOwners = deletedSubmissionRows.flatMap((row) =>
				typeof row.submission_id === 'string' ? [submissionChunkOwner(row.submission_id)] : [],
			);
			createSqlPersistedChunkStore(this.sql).deleteMany(submissionOwners);
			this.sql.exec(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?`,
				sessionKey,
				startedAt,
			);
			this.sql.exec('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', sessionKey);
		});
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
				     max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END,
				     owner_id = ?, lease_expires_at = ?
				 WHERE current.submission_id = ? AND current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running')
				       AND earlier.sequence < current.sequence
				   )
				 RETURNING ${submissionColumns}`,
				claim.attemptId,
				now,
				DURABILITY_DEFAULT_MAX_ATTEMPTS,
				timeoutAt,
				claim.ownerId,
				claim.leaseExpiresAt,
				claim.submissionId,
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			durability?.timeoutAt ?? Date.now() + DURABILITY_DEFAULT_TIMEOUT_MS,
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
					 WHERE submission_id = ? AND status = 'running'
					   AND attempt_id = ? AND input_applied_at IS NULL
					 RETURNING submission_id`,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	private admitSubmission(input: AgentSubmissionInput): AgentDispatchAdmission {
		const { kind, submissionId } = input;
		const prepared =
			kind === 'direct' ? prepareDirectSubmission(input) : { value: input, chunks: [] };
		const payload = JSON.stringify(prepared.value);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(
			input.id,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);
		return this.transactionSync(() => {
			const chunkStore = createSqlPersistedChunkStore(this.sql);
			if (kind === 'dispatch') {
				const receipt = this.getDispatchReceipt(submissionId);
				if (receipt) return { kind: 'retained_receipt', receipt };
			}
			const deleting = this.sql
				.exec(
					'SELECT 1 FROM flue_agent_session_deletions WHERE session_key = ? LIMIT 1',
					sessionKey,
				)
				.toArray();
			if (deleting.length > 0) {
				throw new Error(
					'[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.',
				);
			}
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_submissions
				 (submission_id, session_key, kind, payload, status, accepted_at)
				 VALUES (?, ?, ?, ?, 'queued', ?)`,
				submissionId,
				sessionKey,
				kind,
				payload,
				acceptedAt,
			);
			const row = this.readSubmissionRow(submissionId);
			if (!row)
				throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind) return { kind: 'conflict' };
			const owner = submissionChunkOwner(submissionId);
			if (row.payload !== payload) {
				if (
					kind !== 'direct' ||
					typeof row.payload !== 'string' ||
					!matchesPersistedDirectSubmission(
						input,
						JSON.parse(row.payload) as DirectAgentSubmissionInput,
						chunkStore.read(owner),
					)
				)
					return { kind: 'conflict' };
				return { kind: 'submission', submission: this.parseSubmission(row) };
			}
			const persistedChunks = chunkStore.read(owner);
			if (persistedChunks.length === 0 && prepared.chunks.length > 0) {
				chunkStore.replace(owner, prepared.chunks);
			} else if (!samePersistedChunks(persistedChunks, prepared.chunks)) {
				return { kind: 'conflict' };
			}
			return { kind: 'submission', submission: this.parseSubmission(row) };
		});
	}

	private updateOwnedSubmission(query: string, ...bindings: unknown[]): boolean {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}

	private parseSubmission(row: SqlRow): AgentSubmission {
		return parseSubmission(
			row,
			createSqlPersistedChunkStore(this.sql).read(submissionChunkOwner(String(row.submission_id))),
		);
	}

	private parseOperationalRows(rows: SqlRow[], status: 'queued' | 'active'): AgentSubmission[] {
		const submissions: AgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(this.parseSubmission(row));
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				console.error(
					'[flue] Terminating malformed submission (sequence %d):',
					row.sequence,
					error,
				);
				this.failSubmissionSequence(row.sequence, status, error);
			}
		}
		return submissions;
	}

	private failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
	): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${status === 'queued' ? "status = 'queued'" : "status = 'running'"}`,
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
	'sequence, submission_id, session_key, kind, payload, status, accepted_at, attempt_id, input_applied_at, recovery_requested_at, started_at, error, attempt_count, max_retry, timeout_at, owner_id, lease_expires_at';

function submissionColumnsFor(table: string): string {
	return submissionColumns
		.split(', ')
		.map((column) => `${table}.${column}`)
		.join(', ');
}

// Row parsers are intentionally adapter-specific: each backend has its own
// column types, coercion rules, and storage representation. Keeping them
// local avoids a shared abstraction that would need to accommodate every
// backend's quirks.

function parseTurnJournal(row: SqlRow): AgentTurnJournal {
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
		typeof row.revision !== 'number' ||
		typeof row.created_at !== 'number' ||
		typeof row.updated_at !== 'number' ||
		(row.checkpoint_leaf_id !== null &&
			row.checkpoint_leaf_id !== undefined &&
			typeof row.checkpoint_leaf_id !== 'string') ||
		(row.stream_key !== null &&
			row.stream_key !== undefined &&
			typeof row.stream_key !== 'string') ||
		(row.stream_consumed_at !== null &&
			row.stream_consumed_at !== undefined &&
			typeof row.stream_consumed_at !== 'number') ||
		(row.committed !== 0 && row.committed !== 1) ||
		(row.committed_leaf_id !== null &&
			row.committed_leaf_id !== undefined &&
			typeof row.committed_leaf_id !== 'string')
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
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(typeof row.checkpoint_leaf_id === 'string'
			? { checkpointLeafId: row.checkpoint_leaf_id }
			: {}),
		...(typeof row.tool_request_json === 'string'
			? { toolRequest: JSON.parse(row.tool_request_json) as unknown }
			: {}),
		...(typeof row.stream_key === 'string' ? { streamKey: row.stream_key } : {}),
		...(typeof row.stream_consumed_at === 'number'
			? { streamConsumedAt: row.stream_consumed_at }
			: {}),
		committed: row.committed === 1,
		...(typeof row.committed_leaf_id === 'string'
			? { committedLeafId: row.committed_leaf_id }
			: {}),
	};
}

function parseSubmission(
	row: SqlRow,
	chunks: Parameters<typeof hydratePersistedDirectSubmission>[1],
): AgentSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' && row.status !== 'running' && row.status !== 'settled') ||
		typeof row.accepted_at !== 'number' ||
		(row.attempt_id !== null &&
			row.attempt_id !== undefined &&
			typeof row.attempt_id !== 'string') ||
		(row.input_applied_at !== null &&
			row.input_applied_at !== undefined &&
			typeof row.input_applied_at !== 'number') ||
		(row.recovery_requested_at !== null &&
			row.recovery_requested_at !== undefined &&
			typeof row.recovery_requested_at !== 'number') ||
		(row.started_at !== null &&
			row.started_at !== undefined &&
			typeof row.started_at !== 'number') ||
		(row.status === 'queued' &&
			(row.attempt_id !== null ||
				row.input_applied_at !== null ||
				row.recovery_requested_at !== null ||
				row.started_at !== null)) ||
		(row.status === 'running' &&
			(typeof row.attempt_id !== 'string' || typeof row.started_at !== 'number')) ||
		typeof row.attempt_count !== 'number' ||
		typeof row.max_retry !== 'number' ||
		typeof row.timeout_at !== 'number'
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}
	const parsedPayload = JSON.parse(row.payload);
	const input =
		row.kind === 'direct'
			? hydratePersistedDirectSubmission(parsedPayload as DirectAgentSubmissionInput, chunks)
			: parsedPayload;
	if (
		!isSubmissionPayload(input, {
			kind: row.kind as string,
			submissionId: row.submission_id as string,
			sessionKey: row.session_key as string,
			acceptedAt: row.accepted_at as number,
		})
	) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
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
		...(typeof row.error === 'string' ? { error: row.error } : {}),
		attemptCount: row.attempt_count,
		maxRetry: row.max_retry,
		timeoutAt: row.timeout_at,
		...(typeof row.owner_id === 'string' ? { ownerId: row.owner_id } : {}),
		leaseExpiresAt: typeof row.lease_expires_at === 'number' ? row.lease_expires_at : 0,
	};
}

export function ensureSessionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_sessions (
		 id TEXT PRIMARY KEY,
		 data TEXT NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_session_entries (
		 session_id TEXT NOT NULL,
		 entry_id TEXT NOT NULL,
		 position INTEGER NOT NULL,
		 data TEXT NOT NULL,
		 PRIMARY KEY (session_id, entry_id)
		)`,
	);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS flue_session_entries_session_position_idx
		 ON flue_session_entries (session_id, position ASC)`,
	);
}

function ensureTurnJournalTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_turn_journals (
		 submission_id TEXT PRIMARY KEY,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 attempt_id TEXT NOT NULL,
		 operation_id TEXT NOT NULL,
		 turn_id TEXT NOT NULL,
		 phase TEXT NOT NULL,
		 revision INTEGER NOT NULL,
		 created_at INTEGER NOT NULL,
		 updated_at INTEGER NOT NULL,
		 checkpoint_leaf_id TEXT,
		 tool_request_json TEXT,
		 stream_key TEXT,
		 stream_consumed_at INTEGER,
		 committed INTEGER NOT NULL DEFAULT 0,
		 committed_leaf_id TEXT
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_stream_chunks (
		 stream_key TEXT NOT NULL,
		 segment_index INTEGER NOT NULL,
		 body TEXT NOT NULL,
		 PRIMARY KEY (stream_key, segment_index)
		)`,
	);
}

function ensureSubmissionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (
		 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		 submission_id TEXT NOT NULL UNIQUE,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 status TEXT NOT NULL,
		 accepted_at INTEGER NOT NULL,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 recovery_requested_at INTEGER,
		 started_at INTEGER,
		 settled_at INTEGER,
		 error TEXT,
		 attempt_count INTEGER NOT NULL DEFAULT 0,
		 max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS},
		 timeout_at INTEGER NOT NULL DEFAULT 0,
		 owner_id TEXT,
		 lease_expires_at INTEGER NOT NULL DEFAULT 0
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
		 accepted_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
		 submission_id TEXT NOT NULL,
		 attempt_id TEXT NOT NULL,
		 created_at INTEGER NOT NULL,
		 PRIMARY KEY (submission_id, attempt_id)
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
}
