import type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionInput,
	AgentSubmissionStore,
	DispatchInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionChunkRow,
	SubmissionChunkStore,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	admitSubmissionWithBackend,
	assertSupportedFlueSchemaVersion,
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	FLUE_SCHEMA_VERSION,
	hydratePersistedSubmissionAttachments,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from '@flue/runtime/adapter';
import { MysqlAttachmentStore } from './mysql-attachment-store.ts';
import {
	createMysqlConversationStreamStore,
	MYSQL_CONVERSATION_STREAM_PATH_LIMIT,
} from './mysql-conversation-store.ts';

type SqlRow = Record<string, unknown>;

export type MysqlParameter = string | number | boolean | Uint8Array | null;
export type MysqlQuery = (text: string, params?: MysqlParameter[]) => Promise<SqlRow[]>;

export interface MysqlRunner {
	query: MysqlQuery;
	transaction<T>(fn: (tx: { query: MysqlQuery }) => Promise<T>): Promise<T>;
	close(): void | Promise<void>;
}

export function mysql(runner: MysqlRunner): PersistenceAdapter {
	let closed = false;
	return {
		async migrate() {
			await ensureTables(runner);
		},
		connect() {
			return {
				submissionStore: new MysqlSubmissionStore(runner),
				conversationStreamStore: createMysqlConversationStreamStore(runner),
				attachmentStore: new MysqlAttachmentStore(runner),
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			await runner.close();
		},
	};
}

const schemaTables = {
	flue_meta: ['key', 'value'],
	flue_submission_chunks: ['submission_id', 'item_id', 'chunk_index', 'chunk_count', 'data'],
	flue_agent_session_locks: ['session_key'],
	flue_agent_submissions: [
		'sequence',
		'submission_id',
		'session_key',
		'kind',
		'payload',
		'status',
		'accepted_at',
		'canonical_ready_at',
		'attempt_id',
		'input_applied_at',
		'abort_requested_at',
		'started_at',
		'joined_into',
		'settled_at',
		'error',
		'attempt_count',
		'max_attempts',
		'timeout_at',
		'owner_id',
		'lease_expires_at',
		'settlement_record_id',
		'settlement_record',
	],
	flue_conversation_streams: [
		'path',
		'identity_json',
		'next_offset',
		'producer_id',
		'producer_epoch',
		'next_producer_sequence',
		'incarnation',
	],
	flue_conversation_stream_batches: [
		'path',
		'seq',
		'producer_id',
		'producer_epoch',
		'producer_sequence',
		'data',
		'submission_id',
		'attempt_id',
	],
	flue_attachments: [
		'stream_path',
		'attachment_id',
		'mime_type',
		'byte_size',
		'digest',
		'conversation_id',
		'bytes',
		'created_at',
	],
} as const;

interface SchemaColumn {
	type: string;
	collation?: string;
	nullable: boolean;
	default?: string;
	autoIncrement?: boolean;
}

const criticalColumns: Record<string, SchemaColumn> = {
	'flue_meta.key': { type: 'varchar(64)', collation: 'utf8mb4_bin', nullable: false },
	'flue_submission_chunks.submission_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_submission_chunks.item_id': {
		type: 'varchar(128)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_submission_chunks.chunk_index': { type: 'int', nullable: false },
	'flue_agent_session_locks.session_key': {
		type: 'varchar(512)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_submissions.sequence': {
		type: 'bigint unsigned',
		nullable: false,
		autoIncrement: true,
	},
	'flue_agent_submissions.submission_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_submissions.session_key': {
		type: 'varchar(512)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_submissions.status': { type: 'varchar(16)', collation: 'ascii_bin', nullable: false },
	'flue_agent_submissions.attempt_count': { type: 'int', nullable: false, default: '0' },
	'flue_agent_submissions.max_attempts': {
		type: 'int',
		nullable: false,
		default: String(DURABILITY_DEFAULT_MAX_ATTEMPTS),
	},
	'flue_agent_submissions.timeout_at': { type: 'bigint', nullable: false, default: '0' },
	'flue_agent_submissions.lease_expires_at': { type: 'bigint', nullable: false, default: '0' },
	'flue_conversation_streams.path': {
		type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`,
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_conversation_streams.next_offset': { type: 'bigint', nullable: false, default: '0' },
	'flue_conversation_stream_batches.path': {
		type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`,
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_conversation_stream_batches.seq': { type: 'bigint', nullable: false },
	'flue_conversation_stream_batches.producer_id': {
		type: 'varchar(128)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_attachments.stream_path': {
		type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`,
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_attachments.attachment_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
};

const longtextColumns = [
	'flue_submission_chunks.data',
	'flue_agent_submissions.payload',
	'flue_agent_submissions.error',
	'flue_agent_submissions.settlement_record',
	'flue_conversation_streams.identity_json',
	'flue_conversation_stream_batches.data',
];

const requiredIndexes = [
	{ table: 'flue_meta', name: 'PRIMARY', columns: ['key'], nonUnique: false },
	{
		table: 'flue_submission_chunks',
		name: 'PRIMARY',
		columns: ['submission_id', 'item_id', 'chunk_index'],
		nonUnique: false,
	},
	{
		table: 'flue_agent_session_locks',
		name: 'PRIMARY',
		columns: ['session_key'],
		nonUnique: false,
	},
	{ table: 'flue_agent_submissions', name: 'PRIMARY', columns: ['sequence'], nonUnique: false },
	{ table: 'flue_agent_submissions', columns: ['submission_id'], nonUnique: false },
	{ table: 'flue_agent_submissions', columns: ['status', 'sequence'], nonUnique: true },
	{
		table: 'flue_agent_submissions',
		columns: ['session_key', 'status', 'sequence'],
		nonUnique: true,
	},
	{ table: 'flue_agent_submissions', columns: ['joined_into'], nonUnique: true },
	{ table: 'flue_conversation_streams', name: 'PRIMARY', columns: ['path'], nonUnique: false },
	{
		table: 'flue_conversation_stream_batches',
		name: 'PRIMARY',
		columns: ['path', 'seq'],
		nonUnique: false,
	},
	{
		table: 'flue_conversation_stream_batches',
		columns: ['path', 'producer_id', 'producer_epoch', 'producer_sequence'],
		nonUnique: false,
	},
	{
		table: 'flue_attachments',
		name: 'PRIMARY',
		columns: ['stream_path', 'attachment_id'],
		nonUnique: false,
	},
];

function invalidMysqlSchema(subject: string): Error {
	return new Error(`[flue] MySQL schema ${subject} does not match the required schema.`);
}

async function ensureTables(runner: MysqlRunner): Promise<void> {
	// Read schema_version once (flue_meta may not exist yet on a fresh
	// database): assert a known stored version, or — when unversioned —
	// reject a database that already has other flue_ tables (legacy,
	// pre-version-marker schema) before any DDL runs.
	const metaRows = await runner.query(
		`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_meta'`,
	);
	const versionRows =
		metaRows.length > 0
			? await runner.query(`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`)
			: [];
	const storedVersion = versionRows[0]?.value;
	if (storedVersion !== undefined && storedVersion !== null) {
		assertSupportedFlueSchemaVersion(String(storedVersion));
	} else {
		const existingRows = await runner.query(
			`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'flue\\_%' AND TABLE_NAME <> 'flue_meta' LIMIT 1`,
		);
		if (existingRows.length > 0) assertSupportedFlueSchemaVersion('unversioned');
		// MySQL DDL commits per statement, so the stamp must land BEFORE any
		// other table exists: a crash mid-migration then leaves a versioned
		// store that re-migrates cleanly instead of tripping the
		// unversioned-legacy rejection forever.
		await runner.query(
			`CREATE TABLE IF NOT EXISTS flue_meta (\`key\` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, value VARCHAR(64) NOT NULL) ENGINE=InnoDB`,
		);
		await runner.query(
			`INSERT INTO flue_meta (\`key\`, value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE value = value`,
			[String(FLUE_SCHEMA_VERSION)],
		);
	}
	const ddl = [
		`CREATE TABLE IF NOT EXISTS flue_submission_chunks (submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, item_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, chunk_index INT NOT NULL, chunk_count INT NOT NULL, data LONGTEXT NOT NULL, PRIMARY KEY (submission_id, item_id, chunk_index)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_session_locks (session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE, session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload LONGTEXT NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, accepted_at BIGINT NOT NULL, canonical_ready_at BIGINT, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, input_applied_at BIGINT, abort_requested_at BIGINT, started_at BIGINT, joined_into VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, settled_at BIGINT, error LONGTEXT, attempt_count INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS}, timeout_at BIGINT NOT NULL DEFAULT 0, owner_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, lease_expires_at BIGINT NOT NULL DEFAULT 0, settlement_record_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, settlement_record LONGTEXT, INDEX flue_agent_submissions_status_sequence_idx (status, sequence), INDEX flue_agent_submissions_session_status_sequence_idx (session_key, status, sequence), INDEX flue_agent_submissions_joined_into_idx (joined_into)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_conversation_streams (path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, identity_json LONGTEXT NOT NULL, next_offset BIGINT NOT NULL DEFAULT 0, producer_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, producer_epoch BIGINT NOT NULL DEFAULT 0, next_producer_sequence BIGINT NOT NULL DEFAULT 0, incarnation VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, seq BIGINT NOT NULL, producer_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, producer_epoch BIGINT NOT NULL, producer_sequence BIGINT NOT NULL, data LONGTEXT NOT NULL, submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, PRIMARY KEY (path, seq), UNIQUE INDEX flue_conversation_stream_batches_producer_idx (path, producer_id, producer_epoch, producer_sequence)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_attachments (stream_path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, attachment_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, mime_type VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, byte_size BIGINT UNSIGNED NOT NULL, digest VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, conversation_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, bytes LONGBLOB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (stream_path, attachment_id)) ENGINE=InnoDB`,
	];
	for (const statement of ddl) await runner.query(statement);
	const tables = await runner.query(
		`SELECT TABLE_NAME AS table_name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'flue\\_%'`,
	);
	const engines = new Map(
		tables.map((row) => [String(row.table_name), String(row.engine).toLowerCase()]),
	);
	const definitions = await runner.query(
		`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, COLLATION_NAME AS collation_name, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`,
	);
	const definitionMap = new Map(
		definitions.map((row) => [`${String(row.table_name)}.${String(row.column_name)}`, row]),
	);
	for (const [table, expectedColumns] of Object.entries(schemaTables)) {
		if (engines.get(table) !== 'innodb') throw invalidMysqlSchema(`table ${table}`);
		if (expectedColumns.some((column) => !definitionMap.has(`${table}.${column}`)))
			throw invalidMysqlSchema(`table ${table}`);
	}
	for (const [key, expected] of Object.entries(criticalColumns)) {
		const actual = definitionMap.get(key);
		if (
			String(actual?.column_type).toLowerCase() !== expected.type ||
			String(actual?.is_nullable).toUpperCase() !== (expected.nullable ? 'YES' : 'NO') ||
			(expected.collation !== undefined && actual?.collation_name !== expected.collation) ||
			(expected.default !== undefined && String(actual?.column_default) !== expected.default) ||
			(expected.autoIncrement === true &&
				!String(actual?.extra).toLowerCase().includes('auto_increment'))
		)
			throw invalidMysqlSchema(`column ${key}`);
	}
	for (const key of longtextColumns) {
		const actual = definitionMap.get(key);
		if (String(actual?.column_type).toLowerCase() !== 'longtext')
			throw invalidMysqlSchema(`column ${key}`);
	}
	const indexRows = await runner.query(
		`SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
	);
	const indexes = new Map<
		string,
		{ table: string; name: string; columns: string[]; nonUnique: boolean }
	>();
	for (const row of indexRows) {
		const table = String(row.table_name);
		const name = String(row.index_name);
		const key = `${table}.${name}`;
		const index = indexes.get(key) ?? {
			table,
			name,
			columns: [],
			nonUnique: Number(row.non_unique) === 1,
		};
		index.columns.push(String(row.column_name));
		indexes.set(key, index);
	}
	for (const expected of requiredIndexes) {
		const found = [...indexes.values()].some(
			(index) =>
				index.table === expected.table &&
				(expected.name === undefined || index.name === expected.name) &&
				index.nonUnique === expected.nonUnique &&
				index.columns.length === expected.columns.length &&
				index.columns.every((column, position) => column === expected.columns[position]),
		);
		if (!found)
			throw invalidMysqlSchema(`index on ${expected.table} (${expected.columns.join(', ')})`);
	}
}

interface MysqlQueryRunner {
	query: MysqlQuery;
}

async function lockSession(runner: MysqlQueryRunner, sessionKey: string): Promise<void> {
	await runner.query('INSERT IGNORE INTO flue_agent_session_locks (session_key) VALUES (?)', [
		sessionKey,
	]);
	await runner.query(
		'SELECT session_key FROM flue_agent_session_locks WHERE session_key = ? FOR UPDATE',
		[sessionKey],
	);
}

async function updateIfPresent(
	runner: MysqlRunner,
	select: string,
	selectParams: MysqlParameter[],
	update: string,
	updateParams: MysqlParameter[],
): Promise<boolean> {
	return runner.transaction(async (tx) => {
		const rows = await tx.query(`${select} FOR UPDATE`, selectParams);
		if (!rows[0]) return false;
		await tx.query(update, updateParams);
		return true;
	});
}

/**
 * Joined-delivery settle fan-out, run inside the host's settle transaction:
 * `joined` rows settle with the host's outcome (`error` copied, NULL on
 * success); `joining` stragglers — a join whose canonical input was never
 * confirmed (abort or crash window) — revert to `queued` so the delivery runs
 * as its own submission instead of vanishing.
 */
async function settleJoinedSubmissions(
	runner: MysqlQueryRunner,
	hostSubmissionId: string,
	error: string | null,
): Promise<void> {
	await runner.query(
		`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = ? WHERE joined_into = ? AND status = 'joined'`,
		[Date.now(), error, hostSubmissionId],
	);
	await runner.query(
		`UPDATE flue_agent_submissions SET status = 'queued', joined_into = NULL, input_applied_at = NULL WHERE joined_into = ? AND status = 'joining'`,
		[hostSubmissionId],
	);
}

function createMysqlChunkStore(runner: MysqlQueryRunner): SubmissionChunkStore<Promise<void>> {
	return {
		async read(submissionId) {
			const rows = await runner.query(
				`SELECT item_id, chunk_index, chunk_count, data
				 FROM flue_submission_chunks
				 WHERE submission_id = ?
				 ORDER BY item_id, chunk_index`,
				[submissionId],
			);
			return rows.map(parseSubmissionChunkRow);
		},
		async replace(submissionId, chunks) {
			await runner.query('DELETE FROM flue_submission_chunks WHERE submission_id = ?', [
				submissionId,
			]);
			for (const chunk of chunks) {
				await runner.query(
					`INSERT INTO flue_submission_chunks
					 (submission_id, item_id, chunk_index, chunk_count, data)
					 VALUES (?, ?, ?, ?, ?)`,
					[submissionId, chunk.itemId, chunk.index, chunk.count, chunk.data],
				);
			}
		},
	};
}

function parseSubmissionChunkRow(row: SqlRow): SubmissionChunkRow {
	const index = Number(row.chunk_index);
	const count = Number(row.chunk_count);
	if (
		typeof row.item_id !== 'string' ||
		!Number.isInteger(index) ||
		!Number.isInteger(count) ||
		typeof row.data !== 'string'
	) {
		throw new Error('[flue] Persisted submission chunk row is malformed.');
	}
	return { itemId: row.item_id, index, count, data: row.data };
}

const submissionColumns = [
	'sequence',
	'submission_id',
	'session_key',
	'kind',
	'payload',
	'status',
	'accepted_at',
	'canonical_ready_at',
	'attempt_id',
	'input_applied_at',
	'abort_requested_at',
	'started_at',
	'joined_into',
	'error',
	'settled_at',
	'attempt_count',
	'max_attempts',
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

class MysqlSubmissionStore implements AgentSubmissionStore {
	constructor(private runner: MysqlRunner) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
				[submissionId],
			);
			return rows[0]
				? parseSubmission(rows[0], await createMysqlChunkStore(tx).read(submissionId))
				: null;
		});
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		await this.runner.query(
			`UPDATE flue_agent_submissions SET canonical_ready_at = COALESCE(canonical_ready_at, ?)
			 WHERE submission_id = ? AND status = 'queued'`,
			[Date.now(), submissionId],
		);
		const submission = await this.getSubmission(submissionId);
		return submission?.status === 'queued' ? submission : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		const rows = await this.runner.query(
			`SELECT 1 FROM flue_agent_submissions WHERE status IN ('queued', 'running', 'terminalizing', 'joining', 'joined') LIMIT 1`,
		);
		return rows.length > 0;
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE status = 'queued' AND canonical_ready_at IS NULL
				 ORDER BY sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'queued', tx);
		});
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${prefixed('current_sub')}
			 FROM flue_agent_submissions AS current_sub
			 WHERE current_sub.status = 'queued'
			   AND current_sub.canonical_ready_at IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current_sub.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')
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

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const existing = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ? FOR UPDATE`,
				[attempt.submissionId, attempt.attemptId],
			);
			if (!existing[0]) return null;
			const now = Date.now();
			if (lease) {
				await tx.query(
					`UPDATE flue_agent_submissions SET attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1, owner_id = ?, lease_expires_at = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
					[
						nextAttemptId,
						now,
						lease.ownerId,
						lease.leaseExpiresAt,
						attempt.submissionId,
						attempt.attemptId,
					],
				);
			} else {
				await tx.query(
					`UPDATE flue_agent_submissions SET attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
					[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
				);
			}
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ?`,
				[attempt.submissionId],
			);
			const row = rows[0];
			if (!row) return null;
			return parseSubmission(row, await createMysqlChunkStore(tx).read(attempt.submissionId));
		});
	}

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const admission = await this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
		return this.runner.transaction(async (tx) => {
			const identity = await tx.query(
				"SELECT session_key FROM flue_agent_submissions WHERE submission_id = ? AND status = 'queued' AND canonical_ready_at IS NOT NULL",
				[claim.submissionId],
			);
			if (typeof identity[0]?.session_key !== 'string') return null;
			await lockSession(tx, identity[0].session_key);
			const candidate = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? AND status = 'queued' FOR UPDATE`,
				[claim.submissionId],
			);
			const row = candidate[0];
			if (!row || typeof row.session_key !== 'string') return null;
			const earlier = await tx.query(
				`SELECT sequence FROM flue_agent_submissions WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing', 'joining', 'joined') AND sequence < ? LIMIT 1 FOR UPDATE`,
				[row.session_key, Number(row.sequence)],
			);
			if (earlier[0]) return null;
			await tx.query(
				`UPDATE flue_agent_submissions SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1, max_attempts = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END, owner_id = ?, lease_expires_at = ? WHERE submission_id = ? AND status = 'queued'`,
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
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ?`,
				[claim.submissionId],
			);
			const claimed = rows[0];
			if (!claimed) return null;
			return parseSubmission(claimed, await createMysqlChunkStore(tx).read(claim.submissionId));
		});
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxAttempts: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET max_attempts = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_attempts END, timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END, input_applied_at = COALESCE(input_applied_at, ?) WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[
				durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
				durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
				now,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
	}

	async requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET status = 'queued', attempt_id = NULL, input_applied_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
		);
	}

	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions WHERE session_key = ? AND status IN ('queued', 'running', 'joining', 'joined')`,
				[sessionKey],
			);
			if (rows.length === 0) return [];
			await tx.query(
				`UPDATE flue_agent_submissions SET abort_requested_at = COALESCE(abort_requested_at, ?) WHERE session_key = ? AND status IN ('queued', 'running', 'joining', 'joined')`,
				[Date.now(), sessionKey],
			);
			return rows.map((row) => String(row.submission_id));
		});
	}

	async listPendingSubmissionSettlements(): Promise<
		import('@flue/runtime/adapter').SubmissionSettlementObligation[]
	> {
		const rows = await this.runner.query(
			`SELECT submission_id, session_key, attempt_id, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE status = 'terminalizing' ORDER BY sequence ASC`,
		);
		return rows.map((row) => ({
			submissionId: String(row.submission_id),
			sessionKey: String(row.session_key),
			attemptId: String(row.attempt_id),
			recordId: String(row.settlement_record_id),
			record: JSON.parse(String(row.settlement_record)),
		}));
	}
	async reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: {
			recordId: string;
			record: import('@flue/runtime/adapter').SubmissionSettledRecord;
		},
	): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		return this.runner.transaction(async (tx) => {
			const data = JSON.stringify(settlement.record);
			const rows = await tx.query(
				`SELECT submission_id, session_key, kind, attempt_id, owner_id, status, joined_into, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE submission_id = ? FOR UPDATE`,
				[attempt.submissionId],
			);
			const row = rows[0];
			if (!row) return null;
			// Two reservable shapes, for either submission kind: the submission's
			// own running attempt, or a delivery JOINED into a host that is
			// running under the caller's attempt — the host settles the joined
			// waiter's record under its own authority, adopting the row
			// (attempt_id/started_at) so the terminalizing invariants and
			// finalize fencing hold. Either shape is reservable only while the
			// row is not already reserved (same top-level guard as Postgres).
			const unreserved = row.settlement_record_id == null;
			if (unreserved && row.status === 'running' && row.attempt_id === attempt.attemptId) {
				if (row.owner_id == null) return null;
				await tx.query(
					`UPDATE flue_agent_submissions SET status = 'terminalizing', settlement_record_id = ?, settlement_record = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
					[settlement.recordId, data, attempt.submissionId, attempt.attemptId],
				);
			} else if (unreserved && row.status === 'joined' && row.joined_into != null) {
				// Host gate is a non-locking read (same discipline as the
				// finalize/revert EXISTS gate): the delivery row lock is already
				// held, so never wait on the host row here.
				const host = await tx.query(
					`SELECT 1 FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
					[String(row.joined_into), attempt.attemptId],
				);
				if (!host[0]) return null;
				await tx.query(
					`UPDATE flue_agent_submissions SET status = 'terminalizing', settlement_record_id = ?, settlement_record = ?, attempt_id = ?, started_at = COALESCE(started_at, ?) WHERE submission_id = ? AND status = 'joined'`,
					[settlement.recordId, data, attempt.attemptId, Date.now(), attempt.submissionId],
				);
			} else if (
				row.status !== 'terminalizing' ||
				row.attempt_id !== attempt.attemptId ||
				row.settlement_record_id !== settlement.recordId ||
				row.settlement_record !== data
			)
				return null;
			return {
				submissionId: attempt.submissionId,
				sessionKey: String(row.session_key),
				attemptId: attempt.attemptId,
				recordId: settlement.recordId,
				record: settlement.record,
			};
		});
	}
	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT submission_id, settlement_record FROM flue_agent_submissions WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ? FOR UPDATE`,
				[attempt.submissionId, attempt.attemptId, recordId],
			);
			const row = rows[0];
			if (!row) return false;
			// The durable settlement record is the outcome authority; the row's
			// error column mirrors it — the caller's raw server-side message
			// when provided, else the record's client-safe one.
			const record = JSON.parse(String(row.settlement_record)) as {
				outcome?: string;
				error?: { message?: string };
			};
			const errorMessage =
				record.outcome === 'completed'
					? null
					: (options?.errorMessage ?? record.error?.message ?? 'The submission did not complete.');
			await tx.query(
				`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = ? WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ?`,
				[Date.now(), errorMessage, attempt.submissionId, attempt.attemptId, recordId],
			);
			// A host settles through the outbox; fan its outcome out to joined
			// deliveries the same way completeSubmission/failSubmission do.
			await settleJoinedSubmissions(tx, attempt.submissionId, errorMessage);
			return true;
		});
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.settleRunningSubmission(attempt, null);
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.settleRunningSubmission(
			attempt,
			error instanceof Error ? error.message : String(error),
		);
	}

	private async settleRunningSubmission(
		attempt: SubmissionAttemptRef,
		error: string | null,
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ? FOR UPDATE`,
				[attempt.submissionId, attempt.attemptId],
			);
			if (!rows[0]) return false;
			await tx.query(
				`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
				[Date.now(), error, attempt.submissionId, attempt.attemptId],
			);
			await settleJoinedSubmissions(tx, attempt.submissionId, error);
			return true;
		});
	}

	// ── Turn-boundary joins ──────────────────────────────────────────────

	async claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const identity = await tx.query(
				`SELECT session_key FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
				[host.submissionId, host.attemptId],
			);
			if (typeof identity[0]?.session_key !== 'string') return [];
			await lockSession(tx, identity[0].session_key);
			const hostRows = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ? FOR UPDATE`,
				[host.submissionId, host.attemptId],
			);
			if (!hostRows[0]) return [];
			const queued = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'queued'
				 ORDER BY sequence ASC
				 FOR UPDATE`,
				[identity[0].session_key],
			);
			const chunkStore = createMysqlChunkStore(tx);
			const claimed: AgentSubmission[] = [];
			for (const row of queued) {
				// Contiguous prefix: the first non-joinable row ends the claim so
				// admission order is preserved (everything behind it stays queued).
				if (row.canonical_ready_at == null || row.abort_requested_at != null) {
					break;
				}
				// A malformed row is not joinable and must not fail the host's
				// attempt; it stays queued for the head-scan to terminate once it
				// becomes the session head.
				let submission: AgentSubmission;
				try {
					submission = parseSubmission(row, await chunkStore.read(String(row.submission_id)));
				} catch {
					break;
				}
				if (submission.input.agent !== agentName) break;
				await tx.query(
					`UPDATE flue_agent_submissions SET status = 'joining', joined_into = ? WHERE submission_id = ? AND status = 'queued'`,
					[host.submissionId, submission.submissionId],
				);
				claimed.push({ ...submission, status: 'joining', joinedInto: host.submissionId });
			}
			return claimed;
		});
	}

	async finalizeJoinedSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT delivery.submission_id FROM flue_agent_submissions AS delivery WHERE delivery.submission_id = ? AND delivery.status = 'joining' AND delivery.joined_into = ? AND EXISTS (SELECT 1 FROM flue_agent_submissions AS host WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?)`,
			[submissionId, host.submissionId, host.submissionId, host.attemptId],
			`UPDATE flue_agent_submissions SET status = 'joined', input_applied_at = COALESCE(input_applied_at, ?) WHERE submission_id = ? AND status = 'joining' AND joined_into = ?`,
			[Date.now(), submissionId, host.submissionId],
		);
	}

	async revertJoiningSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT delivery.submission_id FROM flue_agent_submissions AS delivery WHERE delivery.submission_id = ? AND delivery.status = 'joining' AND delivery.joined_into = ? AND EXISTS (SELECT 1 FROM flue_agent_submissions AS host WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?)`,
			[submissionId, host.submissionId, host.submissionId, host.attemptId],
			`UPDATE flue_agent_submissions SET status = 'queued', joined_into = NULL, input_applied_at = NULL WHERE submission_id = ? AND status = 'joining' AND joined_into = ?`,
			[submissionId, host.submissionId],
		);
	}

	async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE joined_into = ? AND status IN ('joining', 'joined')
				 ORDER BY sequence ASC`,
				[hostSubmissionId],
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

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

	private async admitSubmission(input: AgentSubmissionInput): Promise<AgentDispatchAdmission> {
		// MySQL has no INSERT ... ON CONFLICT read-back guarantee under
		// concurrent admissions, so serialize per-session via the lock table
		// before running the shared admission algorithm.
		const sessionKey = createSessionStorageKey(
			input.agent,
			input.id,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);

		return this.runner.transaction(async (tx) => {
			await lockSession(tx, sessionKey);
			const chunkStore = createMysqlChunkStore(tx);
			return admitSubmissionWithBackend<SqlRow>(input, {
				insertIfAbsent: async (row) => {
					await tx.query(
						`INSERT IGNORE INTO flue_agent_submissions
						 (submission_id, session_key, kind, payload, status, accepted_at)
						 VALUES (?, ?, ?, ?, 'queued', ?)`,
						[row.submissionId, row.sessionKey, row.kind, row.payload, row.acceptedAt],
					);
				},
				getExisting: async (submissionId) =>
					(
						await tx.query(
							`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
							[submissionId],
						)
					)[0],
				readChunks: (submissionId) => chunkStore.read(submissionId),
				replaceChunks: (submissionId, chunks) => chunkStore.replace(submissionId, chunks),
				parseSubmission,
			});
		});
	}

	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
		runner: MysqlQueryRunner,
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		const chunkStore = createMysqlChunkStore(runner);
		for (const row of rows) {
			try {
				submissions.push(parseSubmission(row, await chunkStore.read(String(row.submission_id))));
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
		runner: MysqlQueryRunner = this.runner,
	): Promise<void> {
		const statusFilter = status === 'queued' ? "status = 'queued'" : "status = 'running'";
		const message = error instanceof Error ? error.message : String(error);
		// MySQL UPDATE has no RETURNING; read the id inside the caller's
		// transaction before terminating the row.
		const rows = await runner.query(
			`SELECT submission_id FROM flue_agent_submissions WHERE sequence = ? AND ${statusFilter}`,
			[sequence],
		);
		await runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${statusFilter}`,
			[Date.now(), message, sequence],
		);
		// A terminated running host can have joined deliveries gated on its
		// attempt; without the fan-out they would stay unsettled forever and
		// wedge the session queue.
		if (rows[0]) {
			await settleJoinedSubmissions(runner, String(rows[0].submission_id), message);
		}
	}
}

function parseSubmission(row: SqlRow, chunks: readonly SubmissionChunkRow[]): AgentSubmission {
	const sequence = Number(row.sequence);
	const acceptedAt = Number(row.accepted_at);
	const canonicalReadyAt = row.canonical_ready_at != null ? Number(row.canonical_ready_at) : null;
	const attemptCount = Number(row.attempt_count);
	const maxAttempts = Number(row.max_attempts);
	const timeoutAt = Number(row.timeout_at);

	const attemptId = row.attempt_id != null ? String(row.attempt_id) : undefined;
	const inputAppliedAt = row.input_applied_at != null ? Number(row.input_applied_at) : undefined;
	const abortRequestedAt =
		row.abort_requested_at != null ? Number(row.abort_requested_at) : undefined;
	const startedAt = row.started_at != null ? Number(row.started_at) : undefined;
	const joinedInto = row.joined_into != null ? String(row.joined_into) : undefined;
	const settledAt = row.settled_at != null ? Number(row.settled_at) : undefined;
	const ownerId = row.owner_id != null ? String(row.owner_id) : undefined;
	const leaseExpiresAt = Number(row.lease_expires_at);

	if (
		!Number.isFinite(sequence) ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'terminalizing' &&
			row.status !== 'settled' &&
			row.status !== 'joining' &&
			row.status !== 'joined') ||
		!Number.isFinite(acceptedAt) ||
		(canonicalReadyAt !== null && !Number.isFinite(canonicalReadyAt)) ||
		(row.status === 'queued' &&
			(attemptId !== undefined ||
				inputAppliedAt !== undefined ||
				startedAt !== undefined ||
				joinedInto !== undefined)) ||
		((row.status === 'joining' || row.status === 'joined') && joinedInto === undefined) ||
		// Running/terminalizing rows must have attemptId and startedAt.
		((row.status === 'running' || row.status === 'terminalizing') &&
			(attemptId === undefined || startedAt === undefined)) ||
		!Number.isFinite(attemptCount) ||
		!Number.isFinite(maxAttempts) ||
		!Number.isFinite(timeoutAt) ||
		!Number.isFinite(leaseExpiresAt)
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}

	const parsedInput = JSON.parse(row.payload) as AgentSubmissionInput;
	const input = hydratePersistedSubmissionAttachments(parsedInput, chunks);
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
		canonicalReadyAt,
		...(attemptId !== undefined ? { attemptId } : {}),
		...(inputAppliedAt !== undefined ? { inputAppliedAt } : {}),
		...(abortRequestedAt !== undefined ? { abortRequestedAt } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(joinedInto !== undefined ? { joinedInto } : {}),
		...(error !== undefined ? { error } : {}),
		...(settledAt !== undefined ? { settledAt } : {}),
		attemptCount,
		maxAttempts,
		timeoutAt,
		...(ownerId !== undefined ? { ownerId } : {}),
		leaseExpiresAt,
	};
}
