/**
 * Postgres persistence adapter.
 *
 * Implements {@link AgentSubmissionStore} and {@link SessionStore} against a
 * Postgres database using parameterised queries (`$1`, `$2`, ...).
 *
 * The adapter accepts any async SQL runner conforming to {@link PostgresRunner}
 * so that an application can supply its own configured driver, and tests can
 * substitute PGlite without pulling in a real Postgres server.
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
	PgConversationSnapshotStore,
	PgConversationStreamStore,
} from './postgres-conversation-store.ts';

// ─── Bring-your-own-driver runner seam ──────────────────────────────────────

/** A single row returned from a query. */
type SqlRow = Record<string, unknown>;
type SubmissionTerminalOutbox = {
	submissionId: string;
	sessionKey: string;
	attemptId: string;
	eventKey: string;
	event: unknown;
	offset?: string;
};

/**
 * A query over a configured Postgres driver: a SQL string with numbered `$N`
 * placeholders plus positional parameters, resolving to result rows as plain
 * objects.
 */
export type PostgresParameter = string | number | boolean | null;
export type PostgresQuery = (text: string, params?: PostgresParameter[]) => Promise<SqlRow[]>;

/**
 * The driver seam `@flue/postgres` runs against. Wrap your own configured
 * Postgres driver (node-postgres, porsager `postgres`, Neon WebSocket Pool, …) in
 * this shape — `@flue/postgres` does not pick or bundle a driver, so you own
 * driver choice, pooling, TLS, and every other connection option.
 *
 * `transaction` must run `fn` inside one transaction on a single connection,
 * committing on resolve and rolling back on throw. The `tx` passed to `fn`
 * only needs `query`; the adapter never nests transactions.
 */
export interface PostgresRunner {
	query: PostgresQuery;
	transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T>;
	close(): void | Promise<void>;
}

// ─── Public factory ─────────────────────────────────────────────────────────

/**
 * Create a Postgres-backed {@link PersistenceAdapter} from a {@link PostgresRunner}.
 *
 * `@flue/postgres` does not pick or bundle a driver — wrap your own configured
 * driver in the runner shape so you own driver choice and every connection
 * option.
 *
 * @example
 * ```ts
 * import { postgres, type PostgresQuery } from '@flue/postgres';
 * import sql from 'postgres';
 *
 * const db = sql(process.env.DATABASE_URL!);
 *
 * export default postgres({
 *   query: (text, params) => db.unsafe(text, params),
 *   transaction: <T>(fn: (tx: { query: PostgresQuery }) => Promise<T>) =>
 *     db.begin((tx) => fn({ query: (text, params) => tx.unsafe(text, params) })) as Promise<T>,
 *   close: () => db.end(),
 * });
 * ```
 */
export function postgres(runner: PostgresRunner): PersistenceAdapter {
	let closed = false;
	return {
		async migrate() {
			await ensureTables(runner);
		},
		connect() {
			return {
				executionStore: {
					sessions: new PgSessionStore(runner),
					submissions: new PgSubmissionStore(runner),
				},
				runStore: new PgRunStore(runner),
				eventStreamStore: new PgEventStreamStore(runner),
				conversationStreamStore: new PgConversationStreamStore(runner),
				conversationSnapshotStore: new PgConversationSnapshotStore(runner),
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

async function ensureTables(runner: PostgresRunner): Promise<void> {
	// Postgres DDL is transactional — wrap all schema setup in a single
	// transaction so partial failures don't leave the database half-migrated.
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
			await tx.query(
				`INSERT INTO flue_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`,
				[String(FLUE_SCHEMA_VERSION)],
			);
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
				max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS},
				timeout_at BIGINT NOT NULL DEFAULT 0,
				owner_id TEXT,
				lease_expires_at BIGINT NOT NULL DEFAULT 0
			)
		`);

		await tx.query(`ALTER TABLE flue_agent_submissions ADD COLUMN IF NOT EXISTS terminal_key TEXT`);
		await tx.query(`ALTER TABLE flue_agent_submissions ADD COLUMN IF NOT EXISTS terminal_event TEXT`);
		await tx.query(`ALTER TABLE flue_agent_submissions ADD COLUMN IF NOT EXISTS terminal_offset TEXT`);

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
				accepted_at BIGINT NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
				submission_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				created_at BIGINT NOT NULL,
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
				is_error BOOLEAN,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		await tx.query(`ALTER TABLE flue_runs ADD COLUMN IF NOT EXISTS traceparent TEXT`);
		await tx.query(`ALTER TABLE flue_runs ADD COLUMN IF NOT EXISTS tracestate TEXT`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_runs_status_started_idx
			ON flue_runs (status, started_at DESC, run_id DESC)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_event_streams (
				path         TEXT PRIMARY KEY,
				next_offset  BIGINT NOT NULL DEFAULT 0,
				closed       BOOLEAN NOT NULL DEFAULT FALSE
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_event_stream_entries (
				path    TEXT NOT NULL,
				seq     BIGINT NOT NULL,
				data    TEXT NOT NULL,
				PRIMARY KEY (path, seq)
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_streams (
				path TEXT PRIMARY KEY,
				identity_json TEXT NOT NULL,
				next_offset BIGINT NOT NULL DEFAULT 0,
				closed BOOLEAN NOT NULL DEFAULT FALSE,
				producer_id TEXT,
				producer_epoch BIGINT NOT NULL DEFAULT 0,
				next_producer_sequence BIGINT NOT NULL DEFAULT 0,
				incarnation TEXT NOT NULL
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
				path TEXT NOT NULL,
				seq BIGINT NOT NULL,
				producer_id TEXT NOT NULL,
				producer_epoch BIGINT NOT NULL,
				producer_sequence BIGINT NOT NULL,
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

		await tx.query(`ALTER TABLE flue_event_stream_entries ADD COLUMN IF NOT EXISTS event_key TEXT`);
		await tx.query(`
			CREATE UNIQUE INDEX IF NOT EXISTS flue_event_stream_entries_path_event_key_idx
			ON flue_event_stream_entries (path, event_key)
			WHERE event_key IS NOT NULL
		`);
	});
}

// ─── Session store ──────────────────────────────────────────────────────────

interface PostgresQueryRunner {
	query: PostgresQuery;
}

function createPostgresChunkStore(runner: PostgresQueryRunner): PersistedChunkStore<Promise<void>> {
	return {
		async read(owner) {
			const rows = await runner.query(
				`SELECT image_id, chunk_index, chunk_count, data
				 FROM flue_image_chunks
				 WHERE owner_kind = $1 AND owner_id = $2 AND owner_part = $3
				 ORDER BY image_id, chunk_index`,
				[owner.kind, owner.id, owner.part],
			);
			return rows.map(parsePersistedChunkRow);
		},
		async replace(owner, chunks) {
			await deletePostgresChunkOwner(runner, owner);
			for (const chunk of chunks) {
				await runner.query(
					`INSERT INTO flue_image_chunks
					 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[owner.kind, owner.id, owner.part, chunk.imageId, chunk.index, chunk.count, chunk.data],
				);
			}
		},
		async delete(owner) {
			await deletePostgresChunkOwner(runner, owner);
		},
		async deleteMany(owners) {
			for (const owner of owners) await deletePostgresChunkOwner(runner, owner);
		},
		async deleteOwner(kind, id) {
			await runner.query('DELETE FROM flue_image_chunks WHERE owner_kind = $1 AND owner_id = $2', [
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

async function deletePostgresChunkOwner(
	runner: PostgresQueryRunner,
	owner: PersistedChunkOwner,
): Promise<void> {
	await runner.query(
		'DELETE FROM flue_image_chunks WHERE owner_kind = $1 AND owner_id = $2 AND owner_part = $3',
		[owner.kind, owner.id, owner.part],
	);
}

class PgSessionStore implements SessionStore {
	constructor(private runner: PostgresRunner) {}

	async save(id: string, data: SessionData): Promise<void> {
		const { entries: sessionEntries, ...session } = data;
		const entries = sessionEntries.map((entry, position) => {
			const prepared = prepareSessionEntry(entry);
			return { entry, position, data: JSON.stringify(prepared.value), chunks: prepared.chunks };
		});
		await this.runner.transaction(async (tx) => {
			const chunkStore = createPostgresChunkStore(tx);
			await tx.query(
				`INSERT INTO flue_sessions (id, data) VALUES ($1, $2)
				 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
				[id, JSON.stringify(session)],
			);
			const existingRows = await tx.query(
				'SELECT entry_id, position, data FROM flue_session_entries WHERE session_id = $1',
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
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT (session_id, entry_id) DO UPDATE SET
					 position = EXCLUDED.position, data = EXCLUDED.data`,
						[id, entry.id, position, entryData],
					);
				if (chunksChanged) await chunkStore.replace(owner, chunks);
			}
			for (const row of existingRows) {
				if (typeof row.entry_id === 'string' && !retained.has(row.entry_id)) {
					await chunkStore.delete(sessionEntryChunkOwner(id, row.entry_id));
					await tx.query(
						'DELETE FROM flue_session_entries WHERE session_id = $1 AND entry_id = $2',
						[id, row.entry_id],
					);
				}
			}
		});
	}

	async load(id: string): Promise<SessionData | null> {
		return this.runner.transaction(async (tx) => {
			const chunkStore = createPostgresChunkStore(tx);
			const rows = await tx.query(
				'SELECT data FROM flue_sessions WHERE id = $1 LIMIT 1 FOR SHARE',
				[id],
			);
			const row = rows[0];
			if (!row) return null;
			if (typeof row.data !== 'string') {
				throw new Error('[flue] Persisted session row is malformed.');
			}
			const session = JSON.parse(row.data) as Omit<SessionData, 'entries'>;
			const entryRows = await tx.query(
				'SELECT entry_id, data FROM flue_session_entries WHERE session_id = $1 ORDER BY position ASC',
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
			await createPostgresChunkStore(tx).deleteOwner('session_entry', id);
			await tx.query('DELETE FROM flue_session_entries WHERE session_id = $1', [id]);
			await tx.query('DELETE FROM flue_sessions WHERE id = $1', [id]);
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
	'terminal_key',
	'terminal_event',
	'terminal_offset',
].join(', ');

function parseTerminalOutbox(row: SqlRow): SubmissionTerminalOutbox {
	return {
		submissionId: String(row.submission_id),
		sessionKey: String(row.session_key),
		attemptId: String(row.attempt_id),
		eventKey: String(row.terminal_key),
		event: JSON.parse(String(row.terminal_event)),
		...(row.terminal_offset != null ? { offset: String(row.terminal_offset) } : {}),
	};
}

function prefixed(table: string): string {
	return submissionColumns
		.split(', ')
		.map((c) => `${table}.${c}`)
		.join(', ');
}

class PgSubmissionStore implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(private runner: PostgresRunner) {}

	// ── Query ────────────────────────────────────────────────────────────

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = $1 LIMIT 1`,
				[submissionId],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createPostgresChunkStore(tx).read(submissionChunkOwner(submissionId)),
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
			 WHERE submission_id = $1
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
			 SET phase = $1, revision = revision + 1, updated_at = $2,
			     checkpoint_leaf_id = COALESCE($3, checkpoint_leaf_id),
			     tool_request_json = COALESCE($4, tool_request_json),
			     stream_key = COALESCE($5, stream_key)
			 WHERE submission_id = $6 AND attempt_id = $7 AND committed = 0
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

	async appendStreamChunkSegment(
		streamKey: string,
		segmentIndex: number,
		body: string,
	): Promise<boolean> {
		const rows = await this.runner.query(
			`INSERT INTO flue_agent_stream_chunks (stream_key, segment_index, body)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (stream_key, segment_index) DO NOTHING
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
			 WHERE stream_key = $1
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
		await this.runner.query('DELETE FROM flue_agent_stream_chunks WHERE stream_key = $1', [
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
					 SET attempt_id = $1, recovery_requested_at = NULL, started_at = $2, attempt_count = attempt_count + 1,
					     owner_id = $5, lease_expires_at = $6
					 WHERE submission_id = $3 AND status = 'running' AND attempt_id = $4
					 RETURNING ${submissionColumns}`,
						[
							nextAttemptId,
							now,
							attempt.submissionId,
							attempt.attemptId,
							lease.ownerId,
							lease.leaseExpiresAt,
						],
					)
				: await tx.query(
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
			return parseSubmission(
				subRows[0],
				await createPostgresChunkStore(tx).read(submissionChunkOwner(attempt.submissionId)),
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

		// Postgres does not support `UPDATE ... AS alias` with a self-referencing
		// NOT EXISTS subquery the way SQLite does. Use a CTE to identify the
		// candidate, then update by primary key. The outer WHERE re-checks
		// status = 'queued' so that a concurrent claim that committed between
		// the CTE snapshot and the UPDATE cannot double-claim the same row
		// under READ COMMITTED isolation.
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`WITH candidate AS (
			   SELECT s.sequence FROM flue_agent_submissions s
			   WHERE s.submission_id = $7 AND s.status = 'queued'
			     AND NOT EXISTS (
			       SELECT 1 FROM flue_agent_submissions earlier
			       WHERE earlier.session_key = s.session_key
			         AND earlier.status IN ('queued', 'running', 'terminalizing')
			         AND earlier.sequence < s.sequence
			     )
			 )
			 UPDATE flue_agent_submissions
			 SET status = 'running', attempt_id = $1, started_at = $2, attempt_count = attempt_count + 1,
			     max_retry = $3, timeout_at = CASE WHEN timeout_at = 0 THEN $4 ELSE timeout_at END,
			     owner_id = $5, lease_expires_at = $6
			 FROM candidate
			 WHERE flue_agent_submissions.sequence = candidate.sequence
			   AND flue_agent_submissions.status = 'queued'
			 RETURNING ${prefixed('flue_agent_submissions')}`,
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
						await createPostgresChunkStore(tx).read(submissionChunkOwner(claim.submissionId)),
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
			 SET input_applied_at = COALESCE(input_applied_at, $1),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN $2 ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN $3 ELSE timeout_at END
			 WHERE submission_id = $4 AND status = 'running' AND attempt_id = $5
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
			 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
			 WHERE submission_id = $1 AND status = 'running'
			   AND attempt_id = $2 AND input_applied_at IS NULL
			 RETURNING submission_id`,
			[attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async listPendingTerminalOutboxes(): Promise<SubmissionTerminalOutbox[]> {
		const rows = await this.runner.query(`SELECT submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset FROM flue_agent_submissions WHERE kind = 'direct' AND status = 'terminalizing' ORDER BY sequence ASC`);
		return rows.map(parseTerminalOutbox);
	}

	async reserveSubmissionTerminal(attempt: SubmissionAttemptRef, terminal: { eventKey: string; event: unknown }): Promise<SubmissionTerminalOutbox | null> {
		return this.runner.transaction(async (tx) => {
			const data = JSON.stringify(terminal.event);
			const rows = await tx.query(`UPDATE flue_agent_submissions SET status = 'terminalizing', terminal_key = $1, terminal_event = $2 WHERE submission_id = $3 AND kind = 'direct' AND status = 'running' AND attempt_id = $4 AND owner_id IS NOT NULL AND terminal_key IS NULL RETURNING submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset`, [terminal.eventKey, data, attempt.submissionId, attempt.attemptId]);
			if (rows[0]) return parseTerminalOutbox(rows[0]);
			const existing = await tx.query(`SELECT submission_id, session_key, attempt_id, terminal_key, terminal_event, terminal_offset FROM flue_agent_submissions WHERE submission_id = $1 AND kind = 'direct' AND status = 'terminalizing' AND attempt_id = $2`, [attempt.submissionId, attempt.attemptId]);
			return existing[0]?.terminal_key === terminal.eventKey && existing[0]?.terminal_event === data ? parseTerminalOutbox(existing[0]) : null;
		});
	}

	async recordSubmissionTerminalOffset(attempt: SubmissionAttemptRef, eventKey: string, offset: string): Promise<boolean> {
		const rows = await this.runner.query(`UPDATE flue_agent_submissions SET terminal_offset = COALESCE(terminal_offset, $1) WHERE submission_id = $2 AND status = 'terminalizing' AND attempt_id = $3 AND terminal_key = $4 AND (terminal_offset IS NULL OR terminal_offset = $1) RETURNING submission_id`, [offset, attempt.submissionId, attempt.attemptId, eventKey]);
		return rows.length > 0;
	}

	async finalizeSubmissionTerminal(attempt: SubmissionAttemptRef, eventKey: string): Promise<boolean> {
		const rows = await this.runner.query(`UPDATE flue_agent_submissions SET status = 'settled', settled_at = $1 WHERE submission_id = $2 AND kind = 'direct' AND status = 'terminalizing' AND attempt_id = $3 AND terminal_key = $4 AND terminal_offset IS NOT NULL RETURNING submission_id`, [Date.now(), attempt.submissionId, attempt.attemptId, eventKey]);
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
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	// ── Attempt markers ──────────────────────────────────────────────────

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			`INSERT INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (submission_id, attempt_id) DO NOTHING`,
			[attempt.submissionId, attempt.attemptId, Date.now()],
		);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			'DELETE FROM flue_agent_attempt_markers WHERE submission_id = $1 AND attempt_id = $2',
			[attempt.submissionId, attempt.attemptId],
		);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const rows = await this.runner.query(
			'SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers',
		);
		return rows.map((row) => {
			// Postgres returns BIGINT as string; coerce to number.
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
		const placeholders = submissionIds.map((_, i) => `$${i + 3}`).join(', ');
		await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = $1
			 WHERE owner_id = $2 AND status = 'running'
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
			 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < $1
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
			const chunkStore = createPostgresChunkStore(tx);
			if (kind === 'dispatch') {
				const receiptRows = await tx.query(
					'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = $1 LIMIT 1',
					[submissionId],
				);
				if (receiptRows[0]) {
					const receipt = parseDispatchReceipt(receiptRows[0]);
					return { kind: 'retained_receipt' as const, receipt };
				}
			}

			// Serialize admission against concurrent session deletion using an
			// advisory lock keyed on the session name. SELECT ... FOR UPDATE on
			// an empty result acquires no row-level lock, so a concurrent deletion
			// with no existing marker rows could proceed simultaneously. The
			// advisory lock guarantees mutual exclusion regardless of row existence.
			await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey]);
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
		// Use an advisory lock keyed on the session name to serialize against
		// concurrent admissions. SELECT ... FOR UPDATE on an empty result
		// acquires no row-level lock, so without the advisory lock a concurrent
		// admission could slip in when no rows exist for this session key.
		const startedAt = Date.now();
		await this.runner.transaction(async (tx) => {
			await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sessionKey]);
			const active = await tx.query(
				`SELECT 1 FROM flue_agent_submissions
				 WHERE session_key = $1 AND status IN ('queued', 'running', 'terminalizing')
				 LIMIT 1`,
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
				[sessionKey, startedAt],
			);
		});

		// Phase 2: delete the session tree (async, outside transaction).
		try {
			await deleteSessionTree();
		} catch (error) {
			// Remove the deletion marker so the session returns to a usable
			// state. A persistent deleteSessionTree failure must not leave the
			// marker indefinitely blocking future admissions.
			await this.runner.query('DELETE FROM flue_agent_session_deletions WHERE session_key = $1', [
				sessionKey,
			]);
			throw error;
		}

		// Phase 3: clean up settled submission rows and deletion marker.
		await this.runner.transaction(async (tx) => {
			const deletionRows = await tx.query(
				'SELECT started_at FROM flue_agent_session_deletions WHERE session_key = $1',
				[sessionKey],
			);
			const deletionRow = deletionRows[0];
			const startedAt = deletionRow != null ? Number(deletionRow.started_at) : NaN;
			if (!deletionRow || !Number.isFinite(startedAt)) return;
			await tx.query(
				`INSERT INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at)
				 SELECT submission_id, accepted_at
				 FROM flue_agent_submissions
				 WHERE session_key = $1 AND kind = 'dispatch' AND status = 'settled'
				   AND accepted_at <= $2
				 ON CONFLICT (dispatch_id) DO NOTHING`,
				[sessionKey, startedAt],
			);
			// Clean up orphaned stream chunks for journals belonging to deleted submissions.
			await tx.query(
				`DELETE FROM flue_agent_stream_chunks
				 WHERE stream_key IN (
				   SELECT j.stream_key FROM flue_agent_turn_journals j
				   INNER JOIN flue_agent_submissions s ON j.submission_id = s.submission_id
				   WHERE s.session_key = $1 AND s.status = 'settled' AND s.accepted_at <= $2
				     AND j.stream_key IS NOT NULL
				 )`,
				[sessionKey, startedAt],
			);
			// Clean up orphaned turn journals for deleted submissions.
			await tx.query(
				`DELETE FROM flue_agent_turn_journals
				 WHERE submission_id IN (
				   SELECT submission_id FROM flue_agent_submissions
				   WHERE session_key = $1 AND status = 'settled' AND accepted_at <= $2
				 )`,
				[sessionKey, startedAt],
			);
			const deletedSubmissionRows = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions
				 WHERE session_key = $1 AND status = 'settled' AND accepted_at <= $2`,
				[sessionKey, startedAt],
			);
			const submissionOwners = deletedSubmissionRows.flatMap((row) =>
				typeof row.submission_id === 'string' ? [submissionChunkOwner(row.submission_id)] : [],
			);
			await createPostgresChunkStore(tx).deleteMany(submissionOwners);
			await tx.query(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = $1 AND status = 'settled' AND accepted_at <= $2`,
				[sessionKey, startedAt],
			);
			await tx.query('DELETE FROM flue_agent_session_deletions WHERE session_key = $1', [
				sessionKey,
			]);
		});
	}

	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
		runner: PostgresQueryRunner,
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		const chunkStore = createPostgresChunkStore(runner);
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
		runner: PostgresQueryRunner = this.runner,
	): Promise<void> {
		const statusFilter = status === 'queued' ? "status = 'queued'" : "status = 'running'";
		await runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = $1, error = $2
			 WHERE sequence = $3 AND ${statusFilter}`,
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
// coercion rules (e.g. Postgres BIGINT → string), and storage representation.

function parseSubmission(row: SqlRow, chunks: readonly PersistedChunkRow[]): AgentSubmission {
	// Postgres returns BIGINT as string; coerce to number.
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

class PgRunStore implements RunStore {
	constructor(private runner: PostgresRunner) {}

	async createRun(input: CreateRunInput): Promise<void> {
		// Idempotent first-writer-wins: a replayed runId must neither raise a
		// unique violation nor resurrect a terminal record back to 'active'.
		await this.runner.query(
			`INSERT INTO flue_runs
			 (run_id, workflow_name, status, started_at, payload, traceparent, tracestate)
			 VALUES ($1, $2, 'active', $3, $4, $5, $6)
			 ON CONFLICT (run_id) DO NOTHING`,
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
			 SET status = $1, ended_at = $2, is_error = $3, duration_ms = $4, result = $5, error = $6
			 WHERE run_id = $7`,
			[
				input.isError ? 'errored' : 'completed',
				input.endedAt,
				input.isError,
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
			 FROM flue_runs WHERE run_id = $1 LIMIT 1`,
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
			...(row.is_error != null ? { isError: Boolean(row.is_error) } : {}),
			...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
			...(row.result != null ? { result: JSON.parse(String(row.result)) } : {}),
			...(row.error != null ? { error: JSON.parse(String(row.error)) } : {}),
		};
	}

	async lookupRun(runId: string): Promise<WorkflowRunPointer | null> {
		const rows = await this.runner.query(
			`SELECT run_id, workflow_name
			 FROM flue_runs WHERE run_id = $1 LIMIT 1`,
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
		const params: PostgresParameter[] = [];
		let paramIdx = 1;

		if (opts.status) {
			conditions.push(`status = $${paramIdx++}`);
			params.push(opts.status);
		}
		if (opts.workflowName) {
			conditions.push(`workflow_name = $${paramIdx++}`);
			params.push(opts.workflowName);
		}
		if (cursor) {
			conditions.push(`(started_at, run_id) < ($${paramIdx}, $${paramIdx + 1})`);
			params.push(cursor.startedAt, cursor.runId);
			paramIdx += 2;
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
			 LIMIT $${paramIdx}`,
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

function parseRunPointer(row: SqlRow): RunPointer {
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: row.status as RunStatus,
		startedAt: String(row.started_at),
		...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
		...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
		...(row.is_error != null ? { isError: Boolean(row.is_error) } : {}),
	};
}

// ─── Event stream store ─────────────────────────────────────────────────────

class PgEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();
	private pendingAppends = new Map<string, Promise<void>>();

	constructor(private runner: PostgresRunner) {}

	async createStream(path: string): Promise<void> {
		await this.runner.query(
			`INSERT INTO flue_event_streams (path) VALUES ($1)
			 ON CONFLICT (path) DO NOTHING`,
			[path],
		);
	}

	async appendEvent(path: string, event: unknown): Promise<string> {
		const previous = this.pendingAppends.get(path) ?? Promise.resolve();
		const append = previous.then(async () => {
			const data = JSON.stringify(event);
			const offset = await this.runner.transaction(async (tx) => {
				const updated = await tx.query(
					`UPDATE flue_event_streams
					 SET next_offset = next_offset + 1
					 WHERE path = $1 AND closed = FALSE
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
				await tx.query(
					`INSERT INTO flue_event_stream_entries (path, seq, data) VALUES ($1, $2, $3)`,
					[path, seq, data],
				);
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
			const existing = await tx.query(
				`SELECT seq, data FROM flue_event_stream_entries WHERE path = $1 AND event_key = $2 LIMIT 1`,
				[path, key],
			);
			if (existing[0]) {
				if (existing[0].data !== data) throw new TypeError(`Event key "${key}" has a conflicting payload.`);
				return Number(existing[0].seq);
			}
			const updated = await tx.query(
				`UPDATE flue_event_streams SET next_offset = next_offset + 1
				 WHERE path = $1 AND closed = FALSE RETURNING next_offset`,
				[path],
			);
			if (!updated[0]) {
				const meta = await this.getStreamMetaFromRunner(tx, path);
				throw new TypeError(meta ? `Event stream "${path}" is closed.` : `Event stream "${path}" does not exist.`);
			}
			const seq = Number(updated[0].next_offset) - 1;
			await tx.query(
				`INSERT INTO flue_event_stream_entries (path, seq, data, event_key) VALUES ($1, $2, $3, $4)`,
				[path, seq, data, key],
			);
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
			 WHERE path = $1 AND seq > $2
			 ORDER BY seq ASC
			 LIMIT $3`,
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
		await this.runner.query(`UPDATE flue_event_streams SET closed = TRUE WHERE path = $1`, [path]);
		this.notifyListeners(path);
	}

	async getStreamMeta(path: string): Promise<EventStreamMeta | null> {
		return this.getStreamMetaFromRunner(this.runner, path);
	}

	private async getStreamMetaFromRunner(
		runner: { query: PostgresQuery },
		path: string,
	): Promise<EventStreamMeta | null> {
		const rows = await runner.query(
			`SELECT next_offset, closed FROM flue_event_streams WHERE path = $1`,
			[path],
		);

		const row = rows[0];
		if (!row) return null;
		const writeHead = Number(row.next_offset);
		return {
			nextOffset: formatOffset(writeHead - 1),
			closed: Boolean(row.closed),
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
