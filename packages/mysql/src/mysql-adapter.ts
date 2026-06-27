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
	encodeRunCursor,
	FLUE_SCHEMA_VERSION,
	formatOffset,
	hydratePersistedDirectSubmission,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	MAX_LIST_LIMIT,
	MAX_READ_LIMIT,
	matchesPersistedDirectSubmission,
	parseAcceptedAt,
	parseOffset,
	prepareDirectSubmission,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
	samePersistedChunks,
	submissionChunkOwner,
} from '@flue/runtime/adapter';
import { MysqlAttachmentStore } from './mysql-attachment-store.ts';
import {
	MYSQL_CONVERSATION_STREAM_PATH_LIMIT,
	MysqlConversationStreamStore,
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
				executionStore: {
					submissions: new MysqlSubmissionStore(runner),
				},
				runStore: new MysqlRunStore(runner),
				eventStreamStore: new MysqlEventStreamStore(runner),
				conversationStreamStore: new MysqlConversationStreamStore(runner),
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
	flue_image_chunks: [
		'owner_kind',
		'owner_id',
		'owner_part',
		'image_id',
		'chunk_index',
		'chunk_count',
		'data',
	],
	flue_agent_session_locks: ['session_key'],
	flue_agent_submissions: [
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
		'settled_at',
		'error',
		'attempt_count',
		'max_retry',
		'timeout_at',
		'owner_id',
		'lease_expires_at',
		'settlement_record_id',
		'settlement_record',
	],
	flue_agent_turn_journals: [
		'submission_id',
		'session_key',
		'kind',
		'attempt_id',
		'operation_id',
		'turn_id',
		'phase',
		'revision',
		'created_at',
		'updated_at',
		'checkpoint_leaf_id',
		'tool_request_json',
		'committed',
		'committed_leaf_id',
	],
	flue_agent_dispatch_receipts: ['dispatch_id', 'accepted_at'],
	flue_agent_attempt_markers: ['submission_id', 'attempt_id', 'created_at'],
	flue_runs: [
		'run_id',
		'workflow_name',
		'status',
		'started_at',
		'payload',
		'traceparent',
		'tracestate',
		'ended_at',
		'is_error',
		'duration_ms',
		'result',
		'error',
	],
	flue_event_streams: ['path', 'next_offset', 'closed'],
	flue_event_stream_entries: ['path', 'seq', 'data', 'event_key'],
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
	flue_attachments: ['stream_path', 'attachment_id', 'mime_type', 'byte_size', 'digest', 'conversation_id', 'bytes', 'created_at'],
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
	'flue_image_chunks.owner_kind': {
		type: 'varchar(32)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_image_chunks.owner_id': { type: 'varchar(255)', collation: 'utf8mb4_bin', nullable: false },
	'flue_image_chunks.owner_part': {
		type: 'varchar(128)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_image_chunks.image_id': { type: 'varchar(128)', collation: 'utf8mb4_bin', nullable: false },
	'flue_image_chunks.chunk_index': { type: 'int', nullable: false },
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
	'flue_agent_submissions.max_retry': {
		type: 'int',
		nullable: false,
		default: String(DURABILITY_DEFAULT_MAX_ATTEMPTS),
	},
	'flue_agent_submissions.timeout_at': { type: 'bigint', nullable: false, default: '0' },
	'flue_agent_submissions.lease_expires_at': { type: 'bigint', nullable: false, default: '0' },
	'flue_agent_turn_journals.submission_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_dispatch_receipts.dispatch_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_attempt_markers.submission_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_agent_attempt_markers.attempt_id': {
		type: 'varchar(255)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_runs.run_id': { type: 'varchar(255)', collation: 'utf8mb4_bin', nullable: false },
	'flue_runs.workflow_name': { type: 'varchar(255)', collation: 'utf8mb4_bin', nullable: false },
	'flue_runs.status': { type: 'varchar(16)', collation: 'ascii_bin', nullable: false },
	'flue_runs.started_at': { type: 'varchar(64)', collation: 'ascii_bin', nullable: false },
	'flue_runs.traceparent': { type: 'varchar(255)', collation: 'ascii_bin', nullable: true },
	'flue_runs.tracestate': { type: 'longtext', nullable: true },
	'flue_event_streams.path': { type: 'varchar(512)', collation: 'utf8mb4_bin', nullable: false },
	'flue_event_streams.next_offset': { type: 'bigint', nullable: false, default: '0' },
	'flue_event_streams.closed': { type: 'tinyint(1)', nullable: false, default: '0' },
	'flue_event_stream_entries.path': {
		type: 'varchar(512)',
		collation: 'utf8mb4_bin',
		nullable: false,
	},
	'flue_event_stream_entries.seq': { type: 'bigint', nullable: false },
	'flue_conversation_streams.path': { type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`, collation: 'utf8mb4_bin', nullable: false },
	'flue_conversation_streams.next_offset': { type: 'bigint', nullable: false, default: '0' },
	'flue_conversation_stream_batches.path': { type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`, collation: 'utf8mb4_bin', nullable: false },
	'flue_conversation_stream_batches.seq': { type: 'bigint', nullable: false },
	'flue_conversation_stream_batches.producer_id': { type: 'varchar(128)', collation: 'utf8mb4_bin', nullable: false },
	'flue_attachments.stream_path': { type: `varchar(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT})`, collation: 'utf8mb4_bin', nullable: false },
	'flue_attachments.attachment_id': { type: 'varchar(255)', collation: 'utf8mb4_bin', nullable: false },
};

const longtextColumns = [
	'flue_image_chunks.data',
	'flue_agent_submissions.payload',
	'flue_agent_submissions.error',
	'flue_agent_turn_journals.tool_request_json',
	'flue_runs.payload',
	'flue_runs.tracestate',
	'flue_runs.result',
	'flue_runs.error',
	'flue_event_stream_entries.data',
	'flue_conversation_streams.identity_json',
	'flue_conversation_stream_batches.data',
];

const requiredIndexes = [
	{ table: 'flue_meta', name: 'PRIMARY', columns: ['key'], nonUnique: false },
	{
		table: 'flue_image_chunks',
		name: 'PRIMARY',
		columns: ['owner_kind', 'owner_id', 'owner_part', 'image_id', 'chunk_index'],
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
	{
		table: 'flue_agent_turn_journals',
		name: 'PRIMARY',
		columns: ['submission_id'],
		nonUnique: false,
	},
	{
		table: 'flue_agent_dispatch_receipts',
		name: 'PRIMARY',
		columns: ['dispatch_id'],
		nonUnique: false,
	},
	{
		table: 'flue_agent_attempt_markers',
		name: 'PRIMARY',
		columns: ['submission_id', 'attempt_id'],
		nonUnique: false,
	},
	{ table: 'flue_runs', name: 'PRIMARY', columns: ['run_id'], nonUnique: false },
	{ table: 'flue_runs', columns: ['status', 'started_at', 'run_id'], nonUnique: true },
	{ table: 'flue_runs', columns: ['workflow_name', 'started_at', 'run_id'], nonUnique: true },
	{ table: 'flue_event_streams', name: 'PRIMARY', columns: ['path'], nonUnique: false },
	{
		table: 'flue_event_stream_entries',
		name: 'PRIMARY',
		columns: ['path', 'seq'],
		nonUnique: false,
	},
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
	{ table: 'flue_attachments', name: 'PRIMARY', columns: ['stream_path', 'attachment_id'], nonUnique: false },
	{ table: 'flue_attachments', columns: ['stream_path', 'conversation_id'], nonUnique: true },
];

function invalidMysqlSchema(subject: string): Error {
	return new Error(`[flue] MySQL schema ${subject} does not match the required schema.`);
}

async function ensureTables(runner: MysqlRunner): Promise<void> {
	const metaRows = await runner.query(
		`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_meta'`,
	);
	if (metaRows.length > 0) {
		const versionRows = await runner.query(
			`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`,
		);
		const storedVersion = versionRows[0]?.value;
		if (storedVersion !== undefined && storedVersion !== null)
			assertSupportedFlueSchemaVersion(String(storedVersion));
	}
	const existingRows = await runner.query(
		`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'flue\\_%' AND TABLE_NAME <> 'flue_meta' LIMIT 1`,
	);
	if (metaRows.length === 0 || existingRows.length > 0) {
		const versionRows = metaRows.length > 0
			? await runner.query(`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`)
			: [];
		if ((versionRows[0]?.value === undefined || versionRows[0]?.value === null) && existingRows.length > 0)
			assertSupportedFlueSchemaVersion('unversioned');
	}
	const ddl = [
		`CREATE TABLE IF NOT EXISTS flue_meta (\`key\` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, value VARCHAR(64) NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_image_chunks (owner_kind VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, owner_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, owner_part VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, image_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, chunk_index INT NOT NULL, chunk_count INT NOT NULL, data LONGTEXT NOT NULL, PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_session_locks (session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE, session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload LONGTEXT NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, accepted_at BIGINT NOT NULL, canonical_ready_at BIGINT, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, input_applied_at BIGINT, recovery_requested_at BIGINT, started_at BIGINT, settled_at BIGINT, error LONGTEXT, attempt_count INT NOT NULL DEFAULT 0, max_retry INT NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS}, timeout_at BIGINT NOT NULL DEFAULT 0, owner_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, lease_expires_at BIGINT NOT NULL DEFAULT 0, settlement_record_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, settlement_record LONGTEXT, INDEX flue_agent_submissions_status_sequence_idx (status, sequence), INDEX flue_agent_submissions_session_status_sequence_idx (session_key, status, sequence)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_turn_journals (submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, operation_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, turn_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, phase VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, revision INT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, checkpoint_leaf_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, tool_request_json LONGTEXT, committed TINYINT(1) NOT NULL DEFAULT 0, committed_leaf_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (dispatch_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, accepted_at BIGINT NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (submission_id, attempt_id)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_runs (run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, workflow_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, started_at VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload LONGTEXT, traceparent VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin, tracestate LONGTEXT, ended_at VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin, is_error TINYINT(1), duration_ms BIGINT, result LONGTEXT, error LONGTEXT, INDEX flue_runs_status_started_idx (status, started_at DESC, run_id DESC), INDEX flue_runs_workflow_started_idx (workflow_name, started_at DESC, run_id DESC)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_event_streams (path VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, next_offset BIGINT NOT NULL DEFAULT 0, closed TINYINT(1) NOT NULL DEFAULT 0) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_event_stream_entries (path VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, seq BIGINT NOT NULL, data LONGTEXT NOT NULL, event_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, PRIMARY KEY (path, seq), UNIQUE INDEX flue_event_stream_entries_path_event_key_idx (path, event_key)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_conversation_streams (path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, identity_json LONGTEXT NOT NULL, next_offset BIGINT NOT NULL DEFAULT 0, producer_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, producer_epoch BIGINT NOT NULL DEFAULT 0, next_producer_sequence BIGINT NOT NULL DEFAULT 0, incarnation VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, seq BIGINT NOT NULL, producer_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, producer_epoch BIGINT NOT NULL, producer_sequence BIGINT NOT NULL, data LONGTEXT NOT NULL, submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, PRIMARY KEY (path, seq), UNIQUE INDEX flue_conversation_stream_batches_producer_idx (path, producer_id, producer_epoch, producer_sequence)) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS flue_attachments (stream_path VARCHAR(${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, attachment_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, mime_type VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, byte_size BIGINT UNSIGNED NOT NULL, digest VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, conversation_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, bytes LONGBLOB NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (stream_path, attachment_id), INDEX flue_attachments_conversation_idx (stream_path, conversation_id)) ENGINE=InnoDB`,
	];
	for (const statement of ddl) await runner.query(statement);
	for (const repair of [
		{ table: 'flue_event_stream_entries', column: 'event_key', definition: 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' },
		{ table: 'flue_runs', column: 'traceparent', definition: 'VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin' },
		{ table: 'flue_runs', column: 'tracestate', definition: 'LONGTEXT' },
	]) {
		const existing = await runner.query(
			`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
			[repair.table, repair.column],
		);
		if (existing.length === 0) {
			await runner.query(`ALTER TABLE ${repair.table} ADD COLUMN ${repair.column} ${repair.definition}`);
		}
	}
	const eventKeyIndexes = await runner.query(`SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_event_stream_entries' AND INDEX_NAME = 'flue_event_stream_entries_path_event_key_idx'`);
	if (eventKeyIndexes.length === 0) await runner.query(`CREATE UNIQUE INDEX flue_event_stream_entries_path_event_key_idx ON flue_event_stream_entries (path, event_key)`);
	const versionRows = await runner.query(
		`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`,
	);
	const storedVersion = versionRows[0]?.value;
	if (storedVersion !== undefined && storedVersion !== null)
		assertSupportedFlueSchemaVersion(String(storedVersion));
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
	if (storedVersion === undefined || storedVersion === null) {
		await runner.query(
			`INSERT INTO flue_meta (\`key\`, value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE value = value`,
			[String(FLUE_SCHEMA_VERSION)],
		);
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

function createMysqlChunkStore(runner: MysqlQueryRunner): PersistedChunkStore<Promise<void>> {
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
			await deleteMysqlChunkOwner(runner, owner);
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
			await deleteMysqlChunkOwner(runner, owner);
		},
		async deleteMany(owners) {
			for (const owner of owners) await deleteMysqlChunkOwner(runner, owner);
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

async function deleteMysqlChunkOwner(
	runner: MysqlQueryRunner,
	owner: PersistedChunkOwner,
): Promise<void> {
	await runner.query(
		'DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?',
		[owner.kind, owner.id, owner.part],
	);
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

class MysqlSubmissionStore implements AgentSubmissionStore {
	constructor(private runner: MysqlRunner) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
				[submissionId],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createMysqlChunkStore(tx).read(submissionChunkOwner(submissionId)),
					)
				: null;
		});
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const rows = await this.runner.query(
			`SELECT submission_id, session_key, kind, attempt_id, operation_id, turn_id,
				        phase, revision, created_at, updated_at, checkpoint_leaf_id,
				        tool_request_json, committed, committed_leaf_id
			 FROM flue_agent_turn_journals
			 WHERE submission_id = ?
			 LIMIT 1`,
			[submissionId],
		);
		return rows[0] ? parseTurnJournal(rows[0]) : null;
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
			`SELECT 1 FROM flue_agent_submissions WHERE status IN ('queued', 'running', 'terminalizing') LIMIT 1`,
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

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		const toolRequestJson =
			input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest);
		return this.runner.transaction(async (tx) => {
			const owner = await tx.query(
				`SELECT submission_id FROM flue_agent_submissions
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ? FOR UPDATE`,
				[input.submissionId, input.attemptId],
			);
			if (!owner[0]) return false;
			await tx.query(
			`INSERT INTO flue_agent_turn_journals
			 (submission_id, session_key, kind, attempt_id, operation_id, turn_id,
			  phase, revision, created_at, updated_at, checkpoint_leaf_id,
			  tool_request_json, committed, committed_leaf_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, NULL)
			 ON DUPLICATE KEY UPDATE
			   attempt_id = VALUES(attempt_id), operation_id = VALUES(operation_id),
			   turn_id = VALUES(turn_id), phase = VALUES(phase), revision = revision + 1,
			   updated_at = VALUES(updated_at), checkpoint_leaf_id = VALUES(checkpoint_leaf_id),
			   tool_request_json = VALUES(tool_request_json), committed = 0, committed_leaf_id = NULL`,
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
			return true;
		});
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown } = {},
	): Promise<boolean> {
		const now = Date.now();
		return updateIfPresent(
			this.runner,
			'SELECT submission_id FROM flue_agent_turn_journals WHERE submission_id = ? AND attempt_id = ? AND committed = 0',
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_turn_journals SET phase = ?, revision = revision + 1, updated_at = ?, checkpoint_leaf_id = COALESCE(?, checkpoint_leaf_id), tool_request_json = COALESCE(?, tool_request_json) WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
			[
				phase,
				now,
				options.checkpointLeafId ?? null,
				options.toolRequest === undefined ? null : JSON.stringify(options.toolRequest),
				attempt.submissionId,
				attempt.attemptId,
			],
		);
	}

	async commitTurnJournal(
		attempt: SubmissionAttemptRef,
		committedLeafId: string,
	): Promise<boolean> {
		const now = Date.now();
		return updateIfPresent(
			this.runner,
			'SELECT submission_id FROM flue_agent_turn_journals WHERE submission_id = ? AND attempt_id = ? AND committed = 0',
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_turn_journals SET phase = 'committed', revision = revision + 1, updated_at = ?, committed = 1, committed_leaf_id = ? WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
			[now, committedLeafId, attempt.submissionId, attempt.attemptId],
		);
	}

	async replaceTurnJournalAttempt(
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
					`UPDATE flue_agent_submissions SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1, owner_id = ?, lease_expires_at = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
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
					`UPDATE flue_agent_submissions SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
					[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
				);
			}
			await tx.query(
				`UPDATE flue_agent_turn_journals SET attempt_id = ?, revision = revision + 1, updated_at = ? WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
				[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
			);
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ?`,
				[attempt.submissionId],
			);
			const row = rows[0];
			if (!row) return null;
			return parseSubmission(
				row,
				await createMysqlChunkStore(tx).read(submissionChunkOwner(attempt.submissionId)),
			);
		});
	}

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
				`SELECT sequence FROM flue_agent_submissions WHERE session_key = ? AND status IN ('queued', 'running', 'terminalizing') AND sequence < ? LIMIT 1 FOR UPDATE`,
				[row.session_key, Number(row.sequence)],
			);
			if (earlier[0]) return null;
			await tx.query(
				`UPDATE flue_agent_submissions SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1, max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END, owner_id = ?, lease_expires_at = ? WHERE submission_id = ? AND status = 'queued'`,
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
			return parseSubmission(
				claimed,
				await createMysqlChunkStore(tx).read(submissionChunkOwner(claim.submissionId)),
			);
		});
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END, timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END, input_applied_at = COALESCE(input_applied_at, ?) WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[
				durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
				durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
				now,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET recovery_requested_at = COALESCE(recovery_requested_at, ?) WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ? AND input_applied_at IS NULL`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0 WHERE submission_id = ? AND status = 'running' AND attempt_id = ? AND input_applied_at IS NULL`,
			[attempt.submissionId, attempt.attemptId],
		);
	}

	async listPendingSubmissionSettlements(): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation[]> {
		const rows = await this.runner.query(`SELECT submission_id, session_key, attempt_id, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE kind = 'direct' AND status = 'terminalizing' ORDER BY sequence ASC`);
		return rows.map((row) => ({ submissionId: String(row.submission_id), sessionKey: String(row.session_key), attemptId: String(row.attempt_id), recordId: String(row.settlement_record_id), record: JSON.parse(String(row.settlement_record)) }));
	}
	async reserveSubmissionSettlement(attempt: SubmissionAttemptRef, settlement: { recordId: string; record: import('@flue/runtime/adapter').SubmissionSettledRecord }): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		return this.runner.transaction(async (tx) => {
			const data = JSON.stringify(settlement.record);
			const rows = await tx.query(`SELECT submission_id, session_key, kind, attempt_id, owner_id, status, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE submission_id = ? FOR UPDATE`, [attempt.submissionId]);
			const row = rows[0];
			if (!row || row.attempt_id !== attempt.attemptId) return null;
			if (row.status === 'running') {
				if (row.kind !== 'direct' || row.owner_id == null) return null;
				await tx.query(`UPDATE flue_agent_submissions SET status = 'terminalizing', settlement_record_id = ?, settlement_record = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`, [settlement.recordId, data, attempt.submissionId, attempt.attemptId]);
			} else if (row.status !== 'terminalizing' || row.settlement_record_id !== settlement.recordId || row.settlement_record !== data) return null;
			return { submissionId: attempt.submissionId, sessionKey: String(row.session_key), attemptId: attempt.attemptId, recordId: settlement.recordId, record: settlement.record };
		});
	}
	async finalizeSubmissionSettlement(attempt: SubmissionAttemptRef, recordId: string): Promise<boolean> {
		return updateIfPresent(this.runner, `SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ?`, [attempt.submissionId, attempt.attemptId, recordId], `UPDATE flue_agent_submissions SET status = 'settled', settled_at = ? WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ?`, [Date.now(), attempt.submissionId, attempt.attemptId, recordId]);
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = NULL WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return updateIfPresent(
			this.runner,
			`SELECT submission_id FROM flue_agent_submissions WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[attempt.submissionId, attempt.attemptId],
			`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = ? WHERE submission_id = ? AND status = 'running' AND attempt_id = ?`,
			[
				Date.now(),
				error instanceof Error ? error.message : String(error),
				attempt.submissionId,
				attempt.attemptId,
			],
		);
	}

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			`INSERT IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
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
			await lockSession(tx, sessionKey);
			const chunkStore = createMysqlChunkStore(tx);
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
			await tx.query(
				`INSERT IGNORE INTO flue_agent_submissions
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

	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
		runner: MysqlQueryRunner,
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		const chunkStore = createMysqlChunkStore(runner);
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
		runner: MysqlQueryRunner = this.runner,
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

function parseDispatchReceipt(row: SqlRow): { submissionId: string; acceptedAt: number } {
	const acceptedAt = Number(row.accepted_at);
	if (typeof row.dispatch_id !== 'string' || !Number.isFinite(acceptedAt)) {
		throw new Error('[flue] Persisted dispatch receipt row is malformed.');
	}
	return { submissionId: row.dispatch_id, acceptedAt };
}

function parseSubmission(row: SqlRow, chunks: readonly PersistedChunkRow[]): AgentSubmission {
	const sequence = Number(row.sequence);
	const acceptedAt = Number(row.accepted_at);
	const canonicalReadyAt = row.canonical_ready_at != null ? Number(row.canonical_ready_at) : null;
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
		(canonicalReadyAt !== null && !Number.isFinite(canonicalReadyAt)) ||
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
		canonicalReadyAt,
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

class MysqlRunStore implements RunStore {
	constructor(private runner: MysqlRunner) {}

	async createRun(input: CreateRunInput): Promise<void> {
		await this.runner.query(
			`INSERT IGNORE INTO flue_runs
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
			...(row.traceparent != null
				? {
						traceCarrier: {
							traceparent: String(row.traceparent),
							...(row.tracestate != null ? { tracestate: String(row.tracestate) } : {}),
						},
					}
				: {}),
			...(row.ended_at != null ? { endedAt: String(row.ended_at) } : {}),
			...(row.is_error != null ? { isError: parseMysqlBoolean(row.is_error) } : {}),
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
		const params: MysqlParameter[] = [];

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
		const fetchLimit = limit + 1;

		const rows = await this.runner.query(
			`SELECT run_id, workflow_name, status, started_at,
			        ended_at, duration_ms, is_error
			 FROM flue_runs
			 ${where}
			 ORDER BY started_at DESC, run_id DESC
			 LIMIT ${fetchLimit}`,
			params,
		);

		const hasNext = rows.length > limit;
		const pageRows = hasNext ? rows.slice(0, limit) : rows;
		const runs = pageRows.map(parseRunPointer);
		const last = pageRows.at(-1);
		const nextCursor = hasNext && last ? encodeRunCursor(parseRunPointer(last)) : undefined;
		return { runs, nextCursor };
	}
}

function parseMysqlBoolean(value: unknown): boolean {
	const numeric = Number(value);
	if (numeric !== 0 && numeric !== 1) {
		throw new Error('[flue] Persisted MySQL boolean is malformed.');
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
		...(row.is_error != null ? { isError: parseMysqlBoolean(row.is_error) } : {}),
	};
}

class MysqlEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();
	private pendingAppends = new Map<string, Promise<void>>();

	constructor(private runner: MysqlRunner) {}

	async createStream(path: string): Promise<void> {
		await this.runner.query(`INSERT IGNORE INTO flue_event_streams (path) VALUES (?)`, [path]);
	}

	async appendEvent(path: string, event: unknown): Promise<string> {
		const previous = this.pendingAppends.get(path) ?? Promise.resolve();
		const append = previous.then(async () => {
			const data = JSON.stringify(event);
			const offset = await this.runner.transaction(async (tx) => {
				const rows = await tx.query(
					'SELECT next_offset, closed FROM flue_event_streams WHERE path = ? FOR UPDATE',
					[path],
				);
				const row = rows[0];
				if (!row) throw new Error(`[flue] Event stream "${path}" does not exist.`);
				if (parseMysqlBoolean(row.closed))
					throw new Error(`[flue] Event stream "${path}" is closed.`);
				const seq = Number(row.next_offset);
				await tx.query(
					'UPDATE flue_event_streams SET next_offset = next_offset + 1 WHERE path = ? AND closed = 0',
					[path],
				);
				await tx.query('INSERT INTO flue_event_stream_entries (path, seq, data) VALUES (?, ?, ?)', [
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
		const previous = this.pendingAppends.get(path) ?? Promise.resolve();
		const append = previous.then(async () => {
			const data = JSON.stringify(event);
			const offset = await this.runner.transaction(async (tx) => {
				const rows = await tx.query(`SELECT next_offset, closed FROM flue_event_streams WHERE path = ? FOR UPDATE`, [path]);
				const row = rows[0];
				if (!row) throw new TypeError(`Event stream "${path}" does not exist.`);
				if (parseMysqlBoolean(row.closed)) throw new TypeError(`Event stream "${path}" is closed.`);
				const existing = await tx.query(`SELECT seq, data FROM flue_event_stream_entries WHERE path = ? AND event_key = ? LIMIT 1`, [path, key]);
				if (existing[0]) {
					if (existing[0].data !== data) throw new TypeError(`Event key "${key}" has a conflicting payload.`);
					return Number(existing[0].seq);
				}
				const seq = Number(row.next_offset);
				await tx.query(`UPDATE flue_event_streams SET next_offset = next_offset + 1 WHERE path = ? AND closed = 0`, [path]);
				await tx.query(`INSERT INTO flue_event_stream_entries (path, seq, data, event_key) VALUES (?, ?, ?, ?)`, [path, seq, data, key]);
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
			if (this.pendingAppends.get(path) === settled) this.pendingAppends.delete(path);
		}
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
		const rows = await this.runner.query(
			`SELECT seq, data FROM flue_event_stream_entries
			 WHERE path = ? AND seq > ?
			 ORDER BY seq ASC
			 LIMIT ${limit + 1}`,
			[path, startAfter],
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
		runner: { query: MysqlQuery },
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
			closed: parseMysqlBoolean(row.closed),
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
				} catch {}
			}
		}
	}
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
		(row.checkpoint_leaf_id != null && typeof row.checkpoint_leaf_id !== 'string') ||
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
		committed: committed === 1,
		...(typeof row.committed_leaf_id === 'string'
			? { committedLeafId: row.committed_leaf_id }
			: {}),
	};
}
