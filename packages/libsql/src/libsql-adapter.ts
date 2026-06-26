/**
 * libSQL / Turso persistence adapter.
 *
 * Implements {@link AgentSubmissionStore}, {@link SessionStore},
 * {@link RunStore}, and {@link EventStreamStore} against a libSQL / Turso
 * database using SQLite-dialect parameterised queries (`?` placeholders).
 *
 * The adapter accepts any async SQL runner conforming to {@link LibsqlRunner}
 * so that an application can supply its own configured `@libsql/client`, and
 * tests can substitute an in-memory client without pulling in a real server.
 */

import type { WorkflowRunPointer } from '@flue/runtime';
import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateRunInput,
	CreateTurnJournalInput,
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
	DispatchInput,
	EndRunInput,
	EventStreamMeta,
	EventStreamReadResult,
	EventStreamStore,
	ListRunsOpts,
	ListRunsResponse,
	PersistedChunkOwner,
	PersistedChunkRow,
	PersistedChunkStore,
	PersistenceAdapter,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
	SessionData,
	SessionStore,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	assertSupportedFlueSchemaVersion,
	clampLimit,
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DEFAULT_LIST_LIMIT,
	DEFAULT_READ_LIMIT,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	decodeRunCursor,
	deduplicateSessionDeletion,
	encodeRunCursor,
	FLUE_SCHEMA_VERSION,
	formatOffset,
	hydratePersistedDirectSubmission,
	hydratePersistedSessionEntry,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	MAX_LIST_LIMIT,
	MAX_READ_LIMIT,
	matchesPersistedDirectSubmission,
	parseAcceptedAt,
	parseOffset,
	prepareDirectSubmission,
	prepareSessionEntry,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
	samePersistedChunks,
	sessionEntryChunkOwner,
	submissionChunkOwner,
} from '@flue/runtime/adapter';
import {
	LibsqlConversationSnapshotStore,
	LibsqlConversationStreamStore,
} from './libsql-conversation-store.ts';

// ─── Bring-your-own-driver runner seam ──────────────────────────────────────

/** A single row returned from a query. */
type SqlRow = Record<string, unknown>;

/**
 * A query over a configured libSQL driver: a SQL string with `?` placeholders
 * plus positional parameters, resolving to result rows as plain objects.
 */
export type LibsqlParameter = string | number | boolean | null;
export type LibsqlQuery = (text: string, params?: LibsqlParameter[]) => Promise<SqlRow[]>;

/**
 * The driver seam `@flue/libsql` runs against. Wrap your own configured
 * `@libsql/client` (local file, in-memory, or a Turso embedded/remote URL) in
 * this shape — `@flue/libsql` does not pick or bundle a driver, so you own
 * driver choice, sync settings, auth tokens, and every other connection option.
 *
 * `transaction` must run `fn` inside one transaction on a single connection,
 * committing on resolve and rolling back on throw. The `tx` passed to `fn`
 * only needs `query`; the adapter never nests transactions.
 */
export interface LibsqlRunner {
	query: LibsqlQuery;
	transaction<T>(fn: (tx: { query: LibsqlQuery }) => Promise<T>): Promise<T>;
	close(): void | Promise<void>;
}

// ─── Public factory ─────────────────────────────────────────────────────────

/**
 * Create a libSQL-backed {@link PersistenceAdapter} from a {@link LibsqlRunner}.
 *
 * `@flue/libsql` does not pick or bundle a driver — wrap your own configured
 * `@libsql/client` in the runner shape so you own driver choice and every
 * connection option.
 *
 * @example
 * ```ts
 * import { libsql } from '@flue/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({
 *   url: process.env.LIBSQL_URL!,
 *   authToken: process.env.LIBSQL_AUTH_TOKEN,
 * });
 *
 * const toRows = (rs: { rows: ArrayLike<Record<string, unknown>>; columns: string[] }) =>
 *   Array.from(rs.rows, (row) =>
 *     Object.fromEntries(rs.columns.map((column) => [column, row[column]])));
 *
 * let tail: Promise<unknown> = Promise.resolve();
 * const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
 *   const result = tail.then(operation, operation);
 *   tail = result.then(() => undefined, () => undefined);
 *   return result;
 * };
 *
 * export default libsql({
 *   query: (text, params = []) =>
 *     serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
 *   transaction: (fn) => serialize(async () => {
 *     const tx = await client.transaction('write');
 *     try {
 *       const result = await fn({
 *         query: async (text, params = []) =>
 *           toRows(await tx.execute({ sql: text, args: params })),
 *       });
 *       await tx.commit();
 *       return result;
 *     } catch (error) {
 *       await tx.rollback();
 *       throw error;
 *     } finally {
 *       tx.close();
 *     }
 *   }),
 *   close: () => client.close(),
 * });
 * ```
 */
export function libsql(runner: LibsqlRunner): PersistenceAdapter {
	let closed = false;
	return {
		async migrate() {
			await ensureTables(runner);
		},
		connect() {
			return {
				executionStore: {
					sessions: new LibsqlSessionStore(runner),
					submissions: new LibsqlSubmissionStore(runner),
				},
				runStore: new LibsqlRunStore(runner),
				eventStreamStore: new LibsqlEventStreamStore(runner),
				conversationStreamStore: new LibsqlConversationStreamStore(runner),
				conversationSnapshotStore: new LibsqlConversationSnapshotStore(runner),
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			await runner.close();
		},
	};
}

// ─── Schema ─────────────────────────────────────────────────────────────────

async function ensureTables(runner: LibsqlRunner): Promise<void> {
	// Wrap all schema setup in a single transaction so partial failures don't
	// leave the database half-migrated.
	await runner.transaction(async (tx) => {
		// Stamp a fresh database with the current schema version; refuse to
		// touch a database recorded with an unknown or newer version.
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		const versionRows = await tx.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		const storedVersion = versionRows[0]?.value;
		if (storedVersion === undefined || storedVersion === null) {
			await tx.query(`INSERT OR IGNORE INTO flue_meta (key, value) VALUES ('schema_version', ?)`, [
				String(FLUE_SCHEMA_VERSION),
			]);
		} else {
			assertSupportedFlueSchemaVersion(String(storedVersion));
		}

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_sessions (
				id TEXT PRIMARY KEY,
				data TEXT NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_session_entries (
				session_id TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (session_id, entry_id)
			)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_session_entries_session_position_idx
			ON flue_session_entries (session_id, position ASC)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_image_chunks (
				owner_kind TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				owner_part TEXT NOT NULL,
				image_id TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_count INTEGER NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index)
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_submissions (
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
			)
		`);

		for (const statement of [
			`ALTER TABLE flue_agent_submissions ADD COLUMN terminal_key TEXT`,
			`ALTER TABLE flue_agent_submissions ADD COLUMN terminal_event TEXT`,
			`ALTER TABLE flue_agent_submissions ADD COLUMN terminal_offset TEXT`,
		]) {
			try {
				await tx.query(statement);
			} catch (error) {
				if (!String(error).toLowerCase().includes('duplicate column')) throw error;
			}
		}

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
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				checkpoint_leaf_id TEXT,
				tool_request_json TEXT,
				stream_key TEXT,
				stream_consumed_at INTEGER,
				committed INTEGER NOT NULL DEFAULT 0,
				committed_leaf_id TEXT
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_stream_chunks (
				stream_key TEXT NOT NULL,
				segment_index INTEGER NOT NULL,
				body TEXT NOT NULL,
				PRIMARY KEY (stream_key, segment_index)
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_session_deletions (
				session_key TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
				dispatch_id TEXT PRIMARY KEY,
				accepted_at INTEGER NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
				submission_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (submission_id, attempt_id)
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

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_runs (
				run_id TEXT PRIMARY KEY,
				workflow_name TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				payload TEXT,
				traceparent TEXT,
				tracestate TEXT,
				ended_at TEXT,
				is_error INTEGER,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		for (const statement of [
			`ALTER TABLE flue_runs ADD COLUMN traceparent TEXT`,
			`ALTER TABLE flue_runs ADD COLUMN tracestate TEXT`,
		]) {
			try {
				await tx.query(statement);
			} catch (error) {
				if (!String(error).toLowerCase().includes('duplicate column')) throw error;
			}
		}

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_runs_status_started_idx
			ON flue_runs (status, started_at DESC, run_id DESC)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_runs_workflow_started_idx
			ON flue_runs (workflow_name, started_at DESC, run_id DESC)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_event_streams (
				path         TEXT PRIMARY KEY,
				next_offset  INTEGER NOT NULL DEFAULT 0,
				closed       INTEGER NOT NULL DEFAULT 0
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_event_stream_entries (
				path    TEXT NOT NULL,
				seq     INTEGER NOT NULL,
				data    TEXT NOT NULL,
				PRIMARY KEY (path, seq)
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_streams (
				path TEXT PRIMARY KEY,
				identity_json TEXT NOT NULL,
				next_offset INTEGER NOT NULL DEFAULT 0,
				closed INTEGER NOT NULL DEFAULT 0,
				producer_id TEXT,
				producer_epoch INTEGER NOT NULL DEFAULT 0,
				next_producer_sequence INTEGER NOT NULL DEFAULT 0,
				incarnation TEXT NOT NULL
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
				path TEXT NOT NULL,
				seq INTEGER NOT NULL,
				producer_id TEXT NOT NULL,
				producer_epoch INTEGER NOT NULL,
				producer_sequence INTEGER NOT NULL,
				data TEXT NOT NULL,
				submission_id TEXT,
				attempt_id TEXT,
				PRIMARY KEY (path, seq),
				UNIQUE (path, producer_id, producer_epoch, producer_sequence)
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_snapshots (
				path TEXT PRIMARY KEY,
				reducer_version INTEGER NOT NULL,
				stream_offset TEXT NOT NULL,
				data TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);
		try {
			await tx.query(`ALTER TABLE flue_event_stream_entries ADD COLUMN event_key TEXT`);
		} catch (error) {
			if (!String(error).toLowerCase().includes('duplicate column')) throw error;
		}
		await tx.query(`
			CREATE UNIQUE INDEX IF NOT EXISTS flue_event_stream_entries_path_event_key_idx
			ON flue_event_stream_entries (path, event_key)
			WHERE event_key IS NOT NULL
		`);
	});
}

// ─── Session store ──────────────────────────────────────────────────────────

interface LibsqlQueryRunner {
	query: LibsqlQuery;
}

function createLibsqlChunkStore(runner: LibsqlQueryRunner): PersistedChunkStore<Promise<void>> {
	return {
		async read(owner) {
			const rows = await runner.query(
				`SELECT image_id, chunk_index, chunk_count, data
				 FROM flue_image_chunks
				 WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?
				 ORDER BY image_id, chunk_index`,
				[owner.kind, owner.id, owner.part],
			);
			return rows.map(parsePersistedChunkRow);
		},
		async replace(owner, chunks) {
			await deleteLibsqlChunkOwner(runner, owner);
			for (const chunk of chunks) {
				await runner.query(
					`INSERT INTO flue_image_chunks
					 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[owner.kind, owner.id, owner.part, chunk.imageId, chunk.index, chunk.count, chunk.data],
				);
			}
		},
		async delete(owner) {
			await deleteLibsqlChunkOwner(runner, owner);
		},
		async deleteMany(owners) {
			for (const owner of owners) await deleteLibsqlChunkOwner(runner, owner);
		},
		async deleteOwner(kind, id) {
			await runner.query('DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ?', [
				kind,
				id,
			]);
		},
	};
}

function parsePersistedChunkRow(row: SqlRow): PersistedChunkRow {
	const index = Number(row.chunk_index);
	const count = Number(row.chunk_count);
	if (
		typeof row.image_id !== 'string' ||
		!Number.isInteger(index) ||
		!Number.isInteger(count) ||
		typeof row.data !== 'string'
	) {
		throw new Error('[flue] Persisted image chunk row is malformed.');
	}
	return { imageId: row.image_id, index, count, data: row.data };
}

async function deleteLibsqlChunkOwner(
	runner: LibsqlQueryRunner,
	owner: PersistedChunkOwner,
): Promise<void> {
	await runner.query(
		'DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?',
		[owner.kind, owner.id, owner.part],
	);
}

class LibsqlSessionStore implements SessionStore {
	constructor(private runner: LibsqlRunner) {}

	async save(id: string, data: SessionData): Promise<void> {
		const { entries: sessionEntries, ...session } = data;
		const entries = sessionEntries.map((entry, position) => {
			const prepared = prepareSessionEntry(entry);
			return { entry, position, data: JSON.stringify(prepared.value), chunks: prepared.chunks };
		});
		await this.runner.transaction(async (tx) => {
			const chunkStore = createLibsqlChunkStore(tx);
			await tx.query(
				`INSERT INTO flue_sessions (id, data) VALUES (?, ?)
				 ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
				[id, JSON.stringify(session)],
			);
			const existingRows = await tx.query(
				'SELECT entry_id, position, data FROM flue_session_entries WHERE session_id = ?',
				[id],
			);
			const existing = new Map(existingRows.map((row) => [row.entry_id, row]));
			const retained = new Set<string>();
			for (const { entry, position, data: entryData, chunks } of entries) {
				retained.add(entry.id);
				const current = existing.get(entry.id);
				const owner = sessionEntryChunkOwner(id, entry.id);
				const currentChunks = await chunkStore.read(owner);
				const entryChanged = Number(current?.position) !== position || current?.data !== entryData;
				const chunksChanged = !samePersistedChunks(currentChunks, chunks);
				if (!entryChanged && !chunksChanged) continue;
				if (entryChanged)
					await tx.query(
						`INSERT INTO flue_session_entries (session_id, entry_id, position, data)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (session_id, entry_id) DO UPDATE SET
					 position = excluded.position, data = excluded.data`,
						[id, entry.id, position, entryData],
					);
				if (chunksChanged) await chunkStore.replace(owner, chunks);
			}
			for (const row of existingRows) {
				if (typeof row.entry_id === 'string' && !retained.has(row.entry_id)) {
					await chunkStore.delete(sessionEntryChunkOwner(id, row.entry_id));
					await tx.query('DELETE FROM flue_session_entries WHERE session_id = ? AND entry_id = ?', [
						id,
						row.entry_id,
					]);
				}
			}
		});
	}

	async load(id: string): Promise<SessionData | null> {
		return this.runner.transaction(async (tx) => {
			const chunkStore = createLibsqlChunkStore(tx);
			const rows = await tx.query('SELECT data FROM flue_sessions WHERE id = ? LIMIT 1', [id]);
			const row = rows[0];
			if (!row) return null;
			if (typeof row.data !== 'string') {
				throw new Error('[flue] Persisted session row is malformed.');
			}
			const session = JSON.parse(row.data) as Omit<SessionData, 'entries'>;
			const entryRows = await tx.query(
				'SELECT entry_id, data FROM flue_session_entries WHERE session_id = ? ORDER BY position ASC',
				[id],
			);
			return {
				...session,
				entries: await Promise.all(
					entryRows.map(async (entryRow) => {
						if (typeof entryRow.entry_id !== 'string' || typeof entryRow.data !== 'string') {
							throw new Error('[flue] Persisted session entry row is malformed.');
						}
						return hydratePersistedSessionEntry(
							JSON.parse(entryRow.data),
							await chunkStore.read(sessionEntryChunkOwner(id, entryRow.entry_id)),
						);
					}),
				),
			};
		});
	}

	async delete(id: string): Promise<void> {
		await this.runner.transaction(async (tx) => {
			await createLibsqlChunkStore(tx).deleteOwner('session_entry', id);
			await tx.query('DELETE FROM flue_session_entries WHERE session_id = ?', [id]);
			await tx.query('DELETE FROM flue_sessions WHERE id = ?', [id]);
		});
	}
}

// ─── Submission store ───────────────────────────────────────────────────────

const submissionColumns = [
	'sequence',
	'submission_id',
	'session_key',
	'kind',
	'payload',
	'status',
	'accepted_at',
	'attempt_id',
	'input_applied_at',
	'recovery_requested_at',
	'started_at',
	'error',
	'attempt_count',
	'max_retry',
	'timeout_at',
	'owner_id',
	'lease_expires_at',
].join(', ');

function prefixed(table: string): string {
	return submissionColumns
		.split(', ')
		.map((c) => `${table}.${c}`)
		.join(', ');
}

class LibsqlSubmissionStore implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(private runner: LibsqlRunner) {}

	// ── Query ────────────────────────────────────────────────────────────

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
				[submissionId],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createLibsqlChunkStore(tx).read(submissionChunkOwner(submissionId)),
					)
				: null;
		});
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const rows = await this.runner.query(
			`SELECT submission_id, session_key, kind, attempt_id, operation_id, turn_id,
			        phase, revision, created_at, updated_at, checkpoint_leaf_id,
			        tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id
			 FROM flue_agent_turn_journals
			 WHERE submission_id = ?
			 LIMIT 1`,
			[submissionId],
		);
		return rows[0] ? parseTurnJournal(rows[0]) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		const rows = await this.runner.query(
			`SELECT 1 FROM flue_agent_submissions WHERE status IN ('queued', 'running', 'terminalizing') LIMIT 1`,
		);
		return rows.length > 0;
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${prefixed('current_sub')}
			 FROM flue_agent_submissions AS current_sub
			 WHERE current_sub.status = 'queued'
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current_sub.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing')
			       AND earlier.sequence < current_sub.sequence
			   )
			 ORDER BY current_sub.sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'queued', tx);
		});
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
			 FROM flue_agent_submissions
			 WHERE status = 'running'
			 ORDER BY sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

	// ── Turn journal lifecycle ───────────────────────────────────────────

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		const toolRequestJson =
			input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest);
		const rows = await this.runner.query(
			`INSERT INTO flue_agent_turn_journals
			 (submission_id, session_key, kind, attempt_id, operation_id, turn_id,
			  phase, revision, created_at, updated_at, checkpoint_leaf_id,
			  tool_request_json, stream_key, stream_consumed_at, committed, committed_leaf_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, 0, NULL)
			 ON CONFLICT (submission_id) DO UPDATE SET
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
			[
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
				toolRequestJson,
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
			 SET phase = ?, revision = revision + 1, updated_at = ?,
			     checkpoint_leaf_id = COALESCE(?, checkpoint_leaf_id),
			     tool_request_json = COALESCE(?, tool_request_json),
			     stream_key = COALESCE(?, stream_key)
			 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
			 RETURNING submission_id`,
			[
				phase,
				now,
				options.checkpointLeafId ?? null,
				options.toolRequest === undefined ? null : JSON.stringify(options.toolRequest),
				options.streamKey ?? null,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	async commitTurnJournal(
		attempt: SubmissionAttemptRef,
		committedLeafId: string,
	): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_turn_journals
			 SET phase = 'committed', revision = revision + 1, updated_at = ?,
			     committed = 1, committed_leaf_id = ?
			 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
			 RETURNING submission_id`,
			[now, committedLeafId, attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_turn_journals
			 SET revision = revision + 1, updated_at = ?, stream_consumed_at = ?
			 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
			   AND stream_key = ? AND stream_consumed_at IS NULL
			 RETURNING submission_id`,
			[now, now, attempt.submissionId, attempt.attemptId, streamKey],
		);
		return rows.length > 0;
	}

	async appendStreamChunkSegment(
		streamKey: string,
		segmentIndex: number,
		body: string,
	): Promise<boolean> {
		const rows = await this.runner.query(
			`INSERT OR IGNORE INTO flue_agent_stream_chunks (stream_key, segment_index, body)
			 VALUES (?, ?, ?)
			 RETURNING stream_key`,
			[streamKey, segmentIndex, body],
		);
		return rows.length > 0;
	}

	async getStreamChunkSegments(
		streamKey: string,
	): Promise<Array<{ segmentIndex: number; body: string }>> {
		const rows = await this.runner.query(
			`SELECT segment_index, body
			 FROM flue_agent_stream_chunks
			 WHERE stream_key = ?
			 ORDER BY segment_index ASC`,
			[streamKey],
		);
		return rows.map((row) => {
			const segmentIndex = Number(row.segment_index);
			if (!Number.isInteger(segmentIndex) || typeof row.body !== 'string') {
				throw new Error('[flue] Persisted stream chunk row is malformed.');
			}
			return { segmentIndex, body: row.body };
		});
	}

	async deleteStreamChunkSegments(streamKey: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_agent_stream_chunks WHERE stream_key = ?', [
			streamKey,
		]);
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const now = Date.now();
			const subRows = lease
				? await tx.query(
						`UPDATE flue_agent_submissions
					 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1,
					     owner_id = ?, lease_expires_at = ?
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING ${submissionColumns}`,
						[
							nextAttemptId,
							now,
							lease.ownerId,
							lease.leaseExpiresAt,
							attempt.submissionId,
							attempt.attemptId,
						],
					)
				: await tx.query(
						`UPDATE flue_agent_submissions
					 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING ${submissionColumns}`,
						[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
					);
			if (!subRows[0]) return null;
			await tx.query(
				`UPDATE flue_agent_turn_journals
				 SET attempt_id = ?, revision = revision + 1, updated_at = ?
				 WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
				[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
			);
			return parseSubmission(
				subRows[0],
				await createLibsqlChunkStore(tx).read(submissionChunkOwner(attempt.submissionId)),
			);
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

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;

		// SQLite supports `UPDATE ... AS alias` with a self-referencing
		// NOT EXISTS subquery, so the claim is a single statement.
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`UPDATE flue_agent_submissions AS current
			 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
			     max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END,
			     owner_id = ?, lease_expires_at = ?
			 WHERE current.submission_id = ? AND current.status = 'queued'
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing')
			       AND earlier.sequence < current.sequence
			   )
			 RETURNING ${submissionColumns}`,
				[
					claim.attemptId,
					now,
					DURABILITY_DEFAULT_MAX_ATTEMPTS,
					timeoutAt,
					claim.ownerId,
					claim.leaseExpiresAt,
					claim.submissionId,
				],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createLibsqlChunkStore(tx).read(submissionChunkOwner(claim.submissionId)),
					)
				: null;
		});
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[
				now,
				durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
				durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
			 WHERE submission_id = ? AND status = 'running'
			   AND attempt_id = ? AND input_applied_at IS NULL
			 RETURNING submission_id`,
			[attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async listPendingTerminalOutboxes(): Promise<any[]> {
		const rows = await this.runner.query(`SELECT submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset FROM flue_agent_submissions WHERE kind = 'direct' AND status = 'terminalizing' ORDER BY sequence ASC`);
		return rows.map((row) => ({ submissionId: String(row.submission_id), sessionKey: String(row.session_key), attemptId: String(row.attempt_id), eventKey: String(row.terminal_key), event: JSON.parse(String(row.terminal_event)), ...(row.terminal_offset != null ? { offset: String(row.terminal_offset) } : {}) }));
	}
	async reserveSubmissionTerminal(attempt: SubmissionAttemptRef, terminal: { eventKey: string; event: unknown }): Promise<any | null> {
		const data = JSON.stringify(terminal.event);
		const rows = await this.runner.query(`UPDATE flue_agent_submissions SET status = 'terminalizing', terminal_key = ?, terminal_event = ? WHERE submission_id = ? AND kind = 'direct' AND status = 'running' AND attempt_id = ? AND owner_id IS NOT NULL AND terminal_key IS NULL RETURNING submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset`, [terminal.eventKey, data, attempt.submissionId, attempt.attemptId]);
		const row = rows[0] ?? (await this.runner.query(`SELECT submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset FROM flue_agent_submissions WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?`, [attempt.submissionId, attempt.attemptId]))[0];
		return row?.terminal_key === terminal.eventKey && row?.terminal_event === data ? { submissionId: String(row.submission_id), sessionKey: String(row.session_key), attemptId: String(row.attempt_id), eventKey: String(row.terminal_key), event: JSON.parse(String(row.terminal_event)), ...(row.terminal_offset != null ? { offset: String(row.terminal_offset) } : {}) } : null;
	}
	async recordSubmissionTerminalOffset(attempt: SubmissionAttemptRef, eventKey: string, offset: string): Promise<boolean> {
		const rows = await this.runner.query(`UPDATE flue_agent_submissions SET terminal_offset = COALESCE(terminal_offset, ?) WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND terminal_key = ? AND (terminal_offset IS NULL OR terminal_offset = ?) RETURNING submission_id`, [offset, attempt.submissionId, attempt.attemptId, eventKey, offset]);
		return rows.length > 0;
	}
	async finalizeSubmissionTerminal(attempt: SubmissionAttemptRef, eventKey: string): Promise<boolean> {
		const rows = await this.runner.query(`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ? WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND terminal_key = ? AND terminal_offset IS NOT NULL RETURNING submission_id`, [Date.now(), attempt.submissionId, attempt.attemptId, eventKey]);
		return rows.length > 0;
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[
				Date.now(),
				error instanceof Error ? error.message : String(error),
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	// ── Attempt markers ──────────────────────────────────────────────────

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			`INSERT OR IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES (?, ?, ?)`,
			[attempt.submissionId, attempt.attemptId, Date.now()],
		);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			'DELETE FROM flue_agent_attempt_markers WHERE submission_id = ? AND attempt_id = ?',
			[attempt.submissionId, attempt.attemptId],
		);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const rows = await this.runner.query(
			'SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers',
		);
		return rows.map((row) => {
			const createdAt = Number(row.created_at);
			if (
				typeof row.submission_id !== 'string' ||
				typeof row.attempt_id !== 'string' ||
				!Number.isFinite(createdAt)
			) {
				throw new Error('[flue] Persisted attempt marker row is malformed.');
			}
			return { submissionId: row.submission_id, attemptId: row.attempt_id, createdAt };
		});
	}

	// ── Lease management ────────────────────────────────────────────────

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		const now = Date.now();
		const leaseExpiresAt = now + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => '?').join(', ');
		await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`,
			[leaseExpiresAt, ownerId, ...submissionIds],
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const now = Date.now();
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
			 FROM flue_agent_submissions
			 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
			 ORDER BY sequence ASC`,
				[now],
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

	// ── Deletion ─────────────────────────────────────────────────────────

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pendingSessionDeletions, sessionKey, () =>
			this.runSessionDeletion(sessionKey, deleteSessionTree),
		);
	}

	async listPendingSessionDeletions(): Promise<string[]> {
		const rows = await this.runner.query('SELECT session_key FROM flue_agent_session_deletions');
		return rows.map((row) => String(row.session_key));
	}

	// ── Private ──────────────────────────────────────────────────────────

	private async admitSubmission(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
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

		return this.runner.transaction(async (tx) => {
			const chunkStore = createLibsqlChunkStore(tx);
			if (kind === 'dispatch') {
				const receiptRows = await tx.query(
					'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ? LIMIT 1',
					[submissionId],
				);
				if (receiptRows[0]) {
					const receipt = parseDispatchReceipt(receiptRows[0]);
					return { kind: 'retained_receipt' as const, receipt };
				}
			}

			// SQLite has no advisory locks; admission and session deletion are
			// serialized by the surrounding transaction. Reject admission while
			// a deletion marker exists for the session.
			const deletingRows = await tx.query(
				'SELECT 1 FROM flue_agent_session_deletions WHERE session_key = ? LIMIT 1',
				[sessionKey],
			);
			if (deletingRows.length > 0) {
				throw new Error(
					'[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.',
				);
			}

			await tx.query(
				`INSERT OR IGNORE INTO flue_agent_submissions
				 (submission_id, session_key, kind, payload, status, accepted_at)
				 VALUES (?, ?, ?, ?, 'queued', ?)`,
				[submissionId, sessionKey, kind, payload, acceptedAt],
			);

			const readRows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
				[submissionId],
			);
			const row = readRows[0];
			if (!row)
				throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind) return { kind: 'conflict' as const };
			const owner = submissionChunkOwner(submissionId);
			if (row.payload !== payload) {
				const persistedChunks = await chunkStore.read(owner);
				if (
					kind !== 'direct' ||
					typeof row.payload !== 'string' ||
					!matchesPersistedDirectSubmission(
						input,
						JSON.parse(row.payload) as DirectAgentSubmissionInput,
						persistedChunks,
					)
				)
					return { kind: 'conflict' as const };
				return { kind: 'submission' as const, submission: parseSubmission(row, persistedChunks) };
			}
			const persistedChunks = await chunkStore.read(owner);
			if (persistedChunks.length === 0 && prepared.chunks.length > 0) {
				await chunkStore.replace(owner, prepared.chunks);
			} else if (!samePersistedChunks(persistedChunks, prepared.chunks)) {
				return { kind: 'conflict' as const };
			}
			return { kind: 'submission' as const, submission: parseSubmission(row, prepared.chunks) };
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
				 WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing')
				 LIMIT 1`,
				[sessionKey],
			);
			if (active.length > 0) {
				throw new Error(
					'[flue] Session cannot be deleted while durable agent submissions are queued or running. Wait for accepted work to settle, then retry deletion.',
				);
			}
			await tx.query(
				`INSERT OR IGNORE INTO flue_agent_session_deletions (session_key, started_at) VALUES (?, ?)`,
				[sessionKey, deletionStartedAt],
			);
		});

		// Phase 2: delete the session tree (async, outside transaction).
		try {
			await deleteSessionTree();
		} catch (error) {
			// Remove the deletion marker so the session returns to a usable
			// state. A persistent deleteSessionTree failure must not leave the
			// marker indefinitely blocking future admissions.
			await this.runner.query('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', [
				sessionKey,
			]);
			throw error;
		}

		// Phase 3: clean up settled submission rows and deletion marker.
		// Re-read the deletion marker's started_at; if the marker is gone, a
		// concurrent deletion run already completed phase 3 — nothing to do.
		await this.runner.transaction(async (tx) => {
			const deletionRows = await tx.query(
				'SELECT started_at FROM flue_agent_session_deletions WHERE session_key = ?',
				[sessionKey],
			);
			const deletionRow = deletionRows[0];
			const startedAt = deletionRow != null ? Number(deletionRow.started_at) : NaN;
			if (!deletionRow || !Number.isFinite(startedAt)) {
				return;
			}
			await tx.query(
				`INSERT OR IGNORE INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at)
				 SELECT submission_id, accepted_at
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND kind = 'dispatch' AND status = 'settled'
				   AND accepted_at <= ?`,
				[sessionKey, startedAt],
			);
			// Clean up orphaned stream chunks for journals belonging to deleted submissions.
			await tx.query(
				`DELETE FROM flue_agent_stream_chunks
				 WHERE stream_key IN (
				   SELECT j.stream_key FROM flue_agent_turn_journals j
				   INNER JOIN flue_agent_submissions s ON j.submission_id = s.submission_id
				   WHERE s.session_key = ? AND s.status = 'settled' AND s.accepted_at <= ?
				     AND j.stream_key IS NOT NULL
				 )`,
				[sessionKey, startedAt],
			);
			// Clean up orphaned turn journals for deleted submissions.
			await tx.query(
				`DELETE FROM flue_agent_turn_journals
				 WHERE submission_id IN (
				   SELECT submission_id FROM flue_agent_submissions
				   WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?
				 )`,
				[sessionKey, startedAt],
			);
			const deletedSubmissionRows = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?`,
				[sessionKey, startedAt],
			);
			const submissionOwners = deletedSubmissionRows.flatMap((row) =>
				typeof row.submission_id === 'string' ? [submissionChunkOwner(row.submission_id)] : [],
			);
			await createLibsqlChunkStore(tx).deleteMany(submissionOwners);
			await tx.query(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'settled' AND accepted_at <= ?`,
				[sessionKey, startedAt],
			);
			await tx.query('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', [
				sessionKey,
			]);
		});
	}

	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
		runner: LibsqlQueryRunner,
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		const chunkStore = createLibsqlChunkStore(runner);
		for (const row of rows) {
			try {
				submissions.push(
					parseSubmission(
						row,
						await chunkStore.read(submissionChunkOwner(String(row.submission_id))),
					),
				);
			} catch (error) {
				const seq = Number(row.sequence);
				if (!Number.isFinite(seq)) throw error;
				console.error('[flue] Terminating malformed submission (sequence %d):', seq, error);
				await this.failSubmissionSequence(seq, status, error, runner);
			}
		}
		return submissions;
	}

	private async failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
		runner: LibsqlQueryRunner = this.runner,
	): Promise<void> {
		const statusFilter = status === 'queued' ? "status = 'queued'" : "status = 'running'";
		await runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${statusFilter}`,
			[Date.now(), error instanceof Error ? error.message : String(error), sequence],
		);
	}
}

// ─── Submission / turn-journal row parsers ──────────────────────────────────

function parseDispatchReceipt(row: SqlRow): { submissionId: string; acceptedAt: number } {
	const acceptedAt = Number(row.accepted_at);
	if (typeof row.dispatch_id !== 'string' || !Number.isFinite(acceptedAt)) {
		throw new Error('[flue] Persisted dispatch receipt row is malformed.');
	}
	return { submissionId: row.dispatch_id, acceptedAt };
}
// Intentionally adapter-specific: each backend has its own column types,
// coercion rules, and storage representation. libSQL returns INTEGER columns
// as JS numbers, so `Number(...)` coercion is safe and idempotent.

function parseSubmission(row: SqlRow, chunks: readonly PersistedChunkRow[]): AgentSubmission {
	const sequence = Number(row.sequence);
	const acceptedAt = Number(row.accepted_at);
	const attemptCount = Number(row.attempt_count);
	const maxRetry = Number(row.max_retry);
	const timeoutAt = Number(row.timeout_at);

	const attemptId = row.attempt_id != null ? String(row.attempt_id) : undefined;
	const inputAppliedAt = row.input_applied_at != null ? Number(row.input_applied_at) : undefined;
	const recoveryRequestedAt =
		row.recovery_requested_at != null ? Number(row.recovery_requested_at) : undefined;
	const startedAt = row.started_at != null ? Number(row.started_at) : undefined;
	const ownerId = row.owner_id != null ? String(row.owner_id) : undefined;
	const leaseExpiresAt = Number(row.lease_expires_at);

	if (
		!Number.isFinite(sequence) ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' && row.status !== 'running' && row.status !== 'terminalizing' && row.status !== 'settled') ||
		!Number.isFinite(acceptedAt) ||
		// Status-specific invariants: queued rows must not have running fields,
		// running rows must have attemptId and startedAt.
		(row.status === 'queued' &&
			(attemptId !== undefined ||
				inputAppliedAt !== undefined ||
				recoveryRequestedAt !== undefined ||
				startedAt !== undefined)) ||
		(row.status === 'running' && (attemptId === undefined || startedAt === undefined)) ||
		!Number.isFinite(attemptCount) ||
		!Number.isFinite(maxRetry) ||
		!Number.isFinite(timeoutAt) ||
		!Number.isFinite(leaseExpiresAt)
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}

	const parsedInput = JSON.parse(row.payload) as unknown;
	const input =
		row.kind === 'direct'
			? hydratePersistedDirectSubmission(parsedInput as DirectAgentSubmissionInput, chunks)
			: parsedInput;
	if (
		!isSubmissionPayload(input, {
			kind: row.kind as string,
			submissionId: row.submission_id as string,
			sessionKey: row.session_key as string,
			acceptedAt,
		})
	) {
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
		...(ownerId !== undefined ? { ownerId } : {}),
		leaseExpiresAt,
	};
}

// ─── Run store ──────────────────────────────────────────────────────────────

class LibsqlRunStore implements RunStore {
	constructor(private runner: LibsqlRunner) {}

	async createRun(input: CreateRunInput): Promise<void> {
		// Idempotent first-writer-wins: a replayed runId must neither raise a
		// unique violation nor resurrect a terminal record back to 'active'.
		await this.runner.query(
			`INSERT OR IGNORE INTO flue_runs
			 (run_id, workflow_name, status, started_at, payload, traceparent, tracestate)
			 VALUES (?, ?, 'active', ?, ?, ?, ?)`,
			[
				input.runId,
				input.workflowName,
				input.startedAt,
				input.input !== undefined ? JSON.stringify(input.input) : null,
				input.traceCarrier?.traceparent ?? null,
				input.traceCarrier?.tracestate ?? null,
			],
		);
	}

	async endRun(input: EndRunInput): Promise<void> {
		await this.runner.query(
			`UPDATE flue_runs
			 SET status = ?, ended_at = ?, is_error = ?, duration_ms = ?, result = ?, error = ?
			 WHERE run_id = ?`,
			[
				input.isError ? 'errored' : 'completed',
				input.endedAt,
				input.isError ? 1 : 0,
				input.durationMs,
				input.result !== undefined ? JSON.stringify(input.result) : null,
				input.error !== undefined ? JSON.stringify(input.error) : null,
				input.runId,
			],
		);
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		const rows = await this.runner.query(
			`SELECT run_id, workflow_name, status, started_at,
			        payload, traceparent, tracestate, ended_at, is_error, duration_ms, result, error
			 FROM flue_runs WHERE run_id = ? LIMIT 1`,
			[runId],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			runId: String(row.run_id),
			workflowName: String(row.workflow_name),
			status: row.status as RunStatus,
			startedAt: String(row.started_at),
			...(row.payload != null ? { input: JSON.parse(String(row.payload)) } : {}),
			...(typeof row.traceparent === 'string'
				? {
						traceCarrier: {
							traceparent: row.traceparent,
							...(typeof row.tracestate === 'string' ? { tracestate: row.tracestate } : {}),
						},
					}
				: {}),
			...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
			...(row.is_error != null ? { isError: parseSqliteBoolean(row.is_error) } : {}),
			...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
			...(row.result != null ? { result: JSON.parse(String(row.result)) } : {}),
			...(row.error != null ? { error: JSON.parse(String(row.error)) } : {}),
		};
	}

	async lookupRun(runId: string): Promise<WorkflowRunPointer | null> {
		const rows = await this.runner.query(
			`SELECT run_id, workflow_name
			 FROM flue_runs WHERE run_id = ? LIMIT 1`,
			[runId],
		);
		const row = rows[0];
		if (!row) return null;
		return { runId: String(row.run_id), workflowName: String(row.workflow_name) };
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);

		const conditions: string[] = [];
		const params: LibsqlParameter[] = [];

		if (opts.status) {
			conditions.push(`status = ?`);
			params.push(opts.status);
		}
		if (opts.workflowName) {
			conditions.push(`workflow_name = ?`);
			params.push(opts.workflowName);
		}
		if (cursor) {
			conditions.push(`(started_at < ? OR (started_at = ? AND run_id < ?))`);
			params.push(cursor.startedAt, cursor.startedAt, cursor.runId);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
		// Fetch one extra row to determine if there's a next page.
		const fetchLimit = limit + 1;

		const rows = await this.runner.query(
			`SELECT run_id, workflow_name, status, started_at,
			        ended_at, duration_ms, is_error
			 FROM flue_runs
			 ${where}
			 ORDER BY started_at DESC, run_id DESC
			 LIMIT ?`,
			[...params, fetchLimit],
		);

		const hasNext = rows.length > limit;
		const pageRows = hasNext ? rows.slice(0, limit) : rows;
		const runs = pageRows.map(parseRunPointer);
		const last = pageRows.at(-1);
		const nextCursor = hasNext && last ? encodeRunCursor(parseRunPointer(last)) : undefined;
		return { runs, nextCursor };
	}
}

function parseSqliteBoolean(value: unknown): boolean {
	const numeric = Number(value);
	if (numeric !== 0 && numeric !== 1) {
		throw new Error('[flue] Persisted SQLite boolean is malformed.');
	}
	return numeric === 1;
}

function parseRunPointer(row: SqlRow): RunPointer {
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: row.status as RunStatus,
		startedAt: String(row.started_at),
		...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
		...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
		...(row.is_error != null ? { isError: parseSqliteBoolean(row.is_error) } : {}),
	};
}

// ─── Event stream store ─────────────────────────────────────────────────────

class LibsqlEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();
	private pendingAppends = new Map<string, Promise<void>>();

	constructor(private runner: LibsqlRunner) {}

	async createStream(path: string): Promise<void> {
		await this.runner.query(`INSERT OR IGNORE INTO flue_event_streams (path) VALUES (?)`, [path]);
	}

	async appendEvent(path: string, event: unknown): Promise<string> {
		const previous = this.pendingAppends.get(path) ?? Promise.resolve();
		const append = previous.then(async () => {
			const data = JSON.stringify(event);
			const offset = await this.runner.transaction(async (tx) => {
				const updated = await tx.query(
					`UPDATE flue_event_streams
					 SET next_offset = next_offset + 1
					 WHERE path = ? AND closed = 0
					 RETURNING next_offset`,
					[path],
				);

				if (updated.length === 0) {
					const meta = await this.getStreamMetaFromRunner(tx, path);
					if (!meta) {
						throw new Error(`[flue] Event stream "${path}" does not exist.`);
					}
					throw new Error(`[flue] Event stream "${path}" is closed.`);
				}

				const seq = Number(updated[0]?.next_offset) - 1;
				await tx.query(`INSERT INTO flue_event_stream_entries (path, seq, data) VALUES (?, ?, ?)`, [
					path,
					seq,
					data,
				]);
				return seq;
			});

			this.notifyListeners(path);
			return formatOffset(offset);
		});
		const settled = append.then(
			() => undefined,
			() => undefined,
		);
		this.pendingAppends.set(path, settled);
		try {
			return await append;
		} finally {
			if (this.pendingAppends.get(path) === settled) {
				this.pendingAppends.delete(path);
			}
		}
	}

	async appendEventOnce(path: string, key: string, event: unknown): Promise<string> {
		const data = JSON.stringify(event);
		const offset = await this.runner.transaction(async (tx) => {
			const existing = await tx.query(`SELECT seq, data FROM flue_event_stream_entries WHERE path = ? AND event_key = ? LIMIT 1`, [path, key]);
			if (existing[0]) {
				if (existing[0].data !== data) throw new TypeError(`Event key "${key}" has a conflicting payload.`);
				return Number(existing[0].seq);
			}
			const updated = await tx.query(`UPDATE flue_event_streams SET next_offset = next_offset + 1 WHERE path = ? AND closed = 0 RETURNING next_offset`, [path]);
			if (!updated[0]) {
				const meta = await this.getStreamMetaFromRunner(tx, path);
				throw new TypeError(meta ? `Event stream "${path}" is closed.` : `Event stream "${path}" does not exist.`);
			}
			const seq = Number(updated[0].next_offset) - 1;
			await tx.query(`INSERT INTO flue_event_stream_entries (path, seq, data, event_key) VALUES (?, ?, ?, ?)`, [path, seq, data, key]);
			return seq;
		});
		this.notifyListeners(path);
		return formatOffset(offset);
	}

	async readEvents(
		path: string,
		opts?: { offset?: string; limit?: number },
	): Promise<EventStreamReadResult> {
		const meta = await this.getStreamMeta(path);
		if (!meta) {
			return { events: [], nextOffset: formatOffset(-1), upToDate: true, closed: false };
		}

		const rawOffset = opts?.offset ?? '-1';
		const limit = clampLimit(opts?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

		let startAfter: number;
		if (rawOffset === '-1') {
			startAfter = -1;
		} else if (rawOffset === 'now') {
			return {
				events: [],
				nextOffset: meta.nextOffset,
				upToDate: true,
				closed: meta.closed,
			};
		} else {
			startAfter = parseOffset(rawOffset);
		}

		// Fetch one extra row so an exactly-limit page at the tail still
		// reports up-to-date (mirrors SqliteEventStreamStore).
		const rows = await this.runner.query(
			`SELECT seq, data FROM flue_event_stream_entries
			 WHERE path = ? AND seq > ?
			 ORDER BY seq ASC
			 LIMIT ?`,
			[path, startAfter, limit + 1],
		);
		const page = rows.slice(0, limit);

		const events = page.map((row) => ({
			data: JSON.parse(row.data as string) as unknown,
			offset: formatOffset(Number(row.seq)),
		}));

		const lastSeq = events.length > 0 ? Number(page.at(-1)?.seq) : -1;
		const upToDate = rows.length <= limit;

		const nextOffset = events.length > 0 ? formatOffset(lastSeq) : formatOffset(startAfter);

		return {
			events,
			nextOffset,
			upToDate,
			closed: meta.closed,
		};
	}

	async closeStream(path: string): Promise<void> {
		await this.runner.query(`UPDATE flue_event_streams SET closed = 1 WHERE path = ?`, [path]);
		this.notifyListeners(path);
	}

	async getStreamMeta(path: string): Promise<EventStreamMeta | null> {
		return this.getStreamMetaFromRunner(this.runner, path);
	}

	private async getStreamMetaFromRunner(
		runner: { query: LibsqlQuery },
		path: string,
	): Promise<EventStreamMeta | null> {
		const rows = await runner.query(
			`SELECT next_offset, closed FROM flue_event_streams WHERE path = ?`,
			[path],
		);

		const row = rows[0];
		if (!row) return null;
		const writeHead = Number(row.next_offset);
		return {
			nextOffset: formatOffset(writeHead - 1),
			closed: parseSqliteBoolean(row.closed),
		};
	}

	subscribe(path: string, listener: () => void): () => void {
		let bucket = this.listeners.get(path);
		if (!bucket) {
			bucket = new Set();
			this.listeners.set(path, bucket);
		}
		bucket.add(listener);
		const listeners = bucket;
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.listeners.delete(path);
			}
		};
	}

	private notifyListeners(path: string): void {
		const bucket = this.listeners.get(path);
		if (bucket) {
			for (const listener of [...bucket]) {
				try {
					listener();
				} catch {
					// Listener errors are silently dropped.
				}
			}
		}
	}
}

// ─── Row parsers ────────────────────────────────────────────────────────────

function parseTurnJournal(row: SqlRow): AgentTurnJournal {
	const revision = Number(row.revision);
	const createdAt = Number(row.created_at);
	const updatedAt = Number(row.updated_at);
	const committed = Number(row.committed);
	const streamConsumedAt =
		row.stream_consumed_at != null ? Number(row.stream_consumed_at) : undefined;

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
		(row.checkpoint_leaf_id != null && typeof row.checkpoint_leaf_id !== 'string') ||
		(row.stream_key != null && typeof row.stream_key !== 'string') ||
		(streamConsumedAt !== undefined && !Number.isFinite(streamConsumedAt)) ||
		(committed !== 0 && committed !== 1) ||
		(row.committed_leaf_id != null && typeof row.committed_leaf_id !== 'string')
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
		...(typeof row.checkpoint_leaf_id === 'string'
			? { checkpointLeafId: row.checkpoint_leaf_id }
			: {}),
		...(typeof row.tool_request_json === 'string'
			? { toolRequest: JSON.parse(row.tool_request_json) as unknown }
			: {}),
		...(typeof row.stream_key === 'string' ? { streamKey: row.stream_key } : {}),
		...(streamConsumedAt !== undefined ? { streamConsumedAt } : {}),
		committed: committed === 1,
		...(typeof row.committed_leaf_id === 'string'
			? { committedLeafId: row.committed_leaf_id }
			: {}),
	};
}
