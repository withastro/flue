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
 */

import type {
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
import type { SqlStorage } from './sql-storage.ts';
import {
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';
import {
	SUBMISSION_HARNESS_NAME,
	deduplicateSessionDeletion,
	isSubmissionPayload,
	parseAcceptedAt,
} from './adapter-helpers.ts';
import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { createSessionStorageKey } from './session-identity.ts';
import type { SessionData, SessionEntry, SessionStore } from './types.ts';

type SqlRow = Record<string, unknown>;
const SESSION_BLOB_CHUNK_SIZE = 512 * 1024;
const SESSION_BLOB_REF_KEY = '__flueSessionBlobRef';
const SESSION_BLOB_REF_TYPE = 'flue.sessionBlob.v1';

interface StoredSessionBlob {
	entryId: string;
	blobId: string;
	data: string;
}

interface SerializedSessionEntry {
	entryJson: string;
	blobs: StoredSessionBlob[];
}

type SessionMetadata = Omit<SessionData, 'entries'>;

/**
 * Run idempotent DDL for all agent execution store tables.
 * Called by `createSqlAgentExecutionStore` (Cloudflare DO path) and
 * by the `sqlite()` adapter's `migrate()` method (Node).
 */
export function ensureSqlAgentExecutionTables(sql: SqlStorage): void {
	ensureSessionTable(sql);
	ensureSubmissionTable(sql);
	ensureTurnJournalTable(sql);
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
		private transactionSync?: <T>(closure: () => T) => T,
	) {}

	async save(id: string, data: SessionData): Promise<void> {
		const serializedEntries = data.entries.map((entry) => serializeSessionEntry(entry));
		this.runTransaction(() => {
			this.sql.exec('DELETE FROM flue_session_blobs WHERE session_id = ?', id);
			this.sql.exec('DELETE FROM flue_session_entries WHERE session_id = ?', id);
			this.sql.exec(
				'INSERT OR REPLACE INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)',
				id,
				JSON.stringify(sessionMetadata(data)),
				Date.now(),
			);

			for (const [sequence, entry] of data.entries.entries()) {
				const serialized = serializedEntries[sequence]!;
				this.sql.exec(
					`INSERT INTO flue_session_entries
					 (session_id, entry_id, parent_id, sequence, entry_json)
					 VALUES (?, ?, ?, ?, ?)`,
					id,
					entry.id,
					entry.parentId,
					sequence,
					serialized.entryJson,
				);
				for (const blob of serialized.blobs) {
					const segmentCount = Math.ceil(blob.data.length / SESSION_BLOB_CHUNK_SIZE);
					for (
						let offset = 0, segmentIndex = 0;
						offset < blob.data.length;
						offset += SESSION_BLOB_CHUNK_SIZE, segmentIndex++
					) {
						this.sql.exec(
							`INSERT INTO flue_session_blobs
							 (session_id, entry_id, blob_id, segment_index, segment_count, data)
							 VALUES (?, ?, ?, ?, ?, ?)`,
							id,
							blob.entryId,
							blob.blobId,
							segmentIndex,
							segmentCount,
							blob.data.slice(offset, offset + SESSION_BLOB_CHUNK_SIZE),
						);
					}
				}
			}
		});
	}

	async load(id: string): Promise<SessionData | null> {
		const rows = this.sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
		const row = rows[0];
		if (!row) return null;
		if (typeof row.data !== 'string') throw new Error('[flue] Persisted session row is malformed.');
		const metadata = JSON.parse(row.data) as SessionData | SessionMetadata;
		const entryRows = this.sql
			.exec(
				`SELECT entry_id, entry_json
				 FROM flue_session_entries
				 WHERE session_id = ?
				 ORDER BY sequence ASC`,
				id,
			)
			.toArray();
		if (entryRows.length === 0 && Array.isArray((metadata as SessionData).entries)) {
			return metadata as SessionData;
		}

		const blobs = sessionBlobMap(
			this.sql
				.exec(
					`SELECT entry_id, blob_id, segment_index, segment_count, data
					 FROM flue_session_blobs
					 WHERE session_id = ?
					 ORDER BY entry_id ASC, blob_id ASC, segment_index ASC`,
					id,
				)
				.toArray(),
		);
		return {
			...metadata,
			entries: entryRows.map((entryRow) => parseSessionEntryRow(entryRow, blobs)),
		} as SessionData;
	}

	async delete(id: string): Promise<void> {
		this.runTransaction(() => {
			this.sql.exec('DELETE FROM flue_session_blobs WHERE session_id = ?', id);
			this.sql.exec('DELETE FROM flue_session_entries WHERE session_id = ?', id);
			this.sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
		});
	}

	private runTransaction<T>(closure: () => T): T {
		return this.transactionSync ? this.transactionSync(closure) : closure();
	}
}

function sessionMetadata(data: SessionData): SessionMetadata {
	const { entries: _entries, ...metadata } = data;
	return metadata;
}

function serializeSessionEntry(entry: SessionEntry): SerializedSessionEntry {
	const blobs: StoredSessionBlob[] = [];
	let nextBlobIndex = 0;
	return {
		entryJson: JSON.stringify(
			externalizeSessionValue(entry, entry.id, blobs, () => `blob_${nextBlobIndex++}`),
		),
		blobs,
	};
}

function externalizeSessionValue(
	value: unknown,
	entryId: string,
	blobs: StoredSessionBlob[],
	nextBlobId: () => string,
): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => externalizeSessionValue(item, entryId, blobs, nextBlobId));
	}
	if (!isRecord(value)) return value;

	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (isExternalizableSessionBlob(value, key, child)) {
			const blobId = nextBlobId();
			blobs.push({ entryId, blobId, data: child });
			output[key] = { [SESSION_BLOB_REF_KEY]: { type: SESSION_BLOB_REF_TYPE, id: blobId } };
			continue;
		}
		output[key] = externalizeSessionValue(child, entryId, blobs, nextBlobId);
	}
	return output;
}

function isExternalizableSessionBlob(
	parent: Record<string, unknown>,
	key: string,
	value: unknown,
): value is string {
	if (value === '' || typeof value !== 'string') return false;
	if (key !== 'data' && key !== 'blob') return false;
	return (
		parent.type === 'image' ||
		parent.type === 'blob' ||
		parent.type === 'document' ||
		parent.type === 'file'
	);
}

function sessionBlobMap(rows: SqlRow[]): Map<string, string> {
	const chunks = new Map<string, { segmentCount: number; segments: string[] }>();
	for (const row of rows) {
		if (
			typeof row.entry_id !== 'string' ||
			typeof row.blob_id !== 'string' ||
			!isNonNegativeInteger(row.segment_index) ||
			!isPositiveInteger(row.segment_count) ||
			typeof row.data !== 'string'
		) {
			throw new Error('[flue] Persisted session blob row is malformed.');
		}
		const key = sessionBlobKey(row.entry_id, row.blob_id);
		const chunk = chunks.get(key) ?? { segmentCount: row.segment_count, segments: [] };
		if (chunk.segmentCount !== row.segment_count || row.segment_index >= chunk.segmentCount) {
			throw new Error('[flue] Persisted session blob row is malformed.');
		}
		chunk.segments[row.segment_index] = row.data;
		chunks.set(key, chunk);
	}

	const blobs = new Map<string, string>();
	for (const [key, chunk] of chunks) {
		if (chunk.segments.length !== chunk.segmentCount) {
			throw new Error('[flue] Persisted session blob row is malformed.');
		}
		for (const segment of chunk.segments) {
			if (typeof segment !== 'string') {
				throw new Error('[flue] Persisted session blob row is malformed.');
			}
		}
		blobs.set(key, chunk.segments.join(''));
	}
	return blobs;
}

function parseSessionEntryRow(row: SqlRow, blobs: Map<string, string>): SessionEntry {
	if (typeof row.entry_id !== 'string' || typeof row.entry_json !== 'string') {
		throw new Error('[flue] Persisted session entry row is malformed.');
	}
	return hydrateSessionValue(JSON.parse(row.entry_json), row.entry_id, blobs) as SessionEntry;
}

function hydrateSessionValue(value: unknown, entryId: string, blobs: Map<string, string>): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => hydrateSessionValue(item, entryId, blobs));
	}
	if (!isRecord(value)) return value;

	const ref = value[SESSION_BLOB_REF_KEY];
	if (isRecord(ref) && ref.type === SESSION_BLOB_REF_TYPE && typeof ref.id === 'string') {
		const blob = blobs.get(sessionBlobKey(entryId, ref.id));
		if (blob === undefined) throw new Error('[flue] Persisted session blob reference is missing.');
		return blob;
	}

	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		output[key] = hydrateSessionValue(child, entryId, blobs);
	}
	return output;
}

function sessionBlobKey(entryId: string, blobId: string): string {
	return `${entryId}\0${blobId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

class AgentSubmissionStoreImpl implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(
		private sql: SqlStorage,
		private transactionSync: <T>(closure: () => T) => T,
	) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.readSubmissionRow(submissionId);
		return row ? parseSubmission(row) : null;
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
					 (stream_key, segment_index, body, created_at)
					 VALUES (?, ?, ?, ?)
					 RETURNING stream_key`,
					streamKey,
					segmentIndex,
					body,
					Date.now(),
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
			return parseSubmission(row);
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
				throw new Error('[flue] Missing session deletion marker during cleanup.');
			}
			const startedAt = deletionRow.started_at;
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at, settled_at)
				 SELECT submission_id, accepted_at, COALESCE(settled_at, accepted_at)
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
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MINUTES * 60_000;
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = 1,
				     max_retry = ?, timeout_at = ?, owner_id = ?, lease_expires_at = ?
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
				DURABILITY_DEFAULT_MAX_RETRY,
				timeoutAt,
				claim.ownerId,
				claim.leaseExpiresAt,
				claim.submissionId,
			)
			.toArray()[0];
		return row ? parseSubmission(row) : null;
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
			durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_RETRY,
			durability?.timeoutAt ?? Date.now() + DURABILITY_DEFAULT_TIMEOUT_MINUTES * 60_000,
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
		const payload = JSON.stringify(input);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, SUBMISSION_HARNESS_NAME, input.session);
		return this.transactionSync(() => {
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
			if (row.kind !== kind || row.payload !== payload) return { kind: 'conflict' };
			return { kind: 'submission', submission: parseSubmission(row) };
		});
	}

	private updateOwnedSubmission(query: string, ...bindings: unknown[]): boolean {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}

	private parseOperationalRows(rows: SqlRow[], status: 'queued' | 'active'): AgentSubmission[] {
		const submissions: AgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(parseSubmission(row));
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

function parseSubmission(row: SqlRow): AgentSubmission {
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
	const input = JSON.parse(row.payload) as unknown;
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
		 data TEXT NOT NULL,
		 updated_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_session_entries (
		 session_id TEXT NOT NULL,
		 entry_id TEXT NOT NULL,
		 parent_id TEXT,
		 sequence INTEGER NOT NULL,
		 entry_json TEXT NOT NULL,
		 PRIMARY KEY (session_id, entry_id)
		)`,
	);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS flue_session_entries_session_sequence_idx
		 ON flue_session_entries (session_id, sequence ASC)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_session_blobs (
		 session_id TEXT NOT NULL,
		 entry_id TEXT NOT NULL,
		 blob_id TEXT NOT NULL,
		 segment_index INTEGER NOT NULL,
		 segment_count INTEGER NOT NULL,
		 data TEXT NOT NULL,
		 PRIMARY KEY (session_id, entry_id, blob_id, segment_index)
		)`,
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
		 created_at INTEGER NOT NULL,
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
		 max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_RETRY},
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
