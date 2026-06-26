/**
 * Persisted-store schema versioning.
 *
 * Every persisted Flue store durably records the schema/format version it was
 * created with, and refuses to open a store recorded with an unknown or newer
 * version. This is a storage-agnostic obligation of the
 * {@link PersistenceAdapter} contract: the built-in SQL backends implement it
 * with a one-row `flue_meta` key/value table; non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */

import { PersistedSchemaVersionError } from './errors.ts';
import type { SqlStorage } from './sql-storage.ts';

/**
 * Current schema/format version of Flue's built-in persisted stores.
 *
 * Bump this when a persisted format changes incompatibly, together with
 * `migrate()` logic that brings older stores to the new version.
 */
export const FLUE_SCHEMA_VERSION = 4;

/**
 * Throw {@link PersistedSchemaVersionError} unless the stored version matches
 * the current {@link FLUE_SCHEMA_VERSION}.
 *
 * Adapters call this with the version value they recorded at store creation.
 * A version greater than the current one means the store was written by a
 * newer Flue version and must not be read; any other mismatch means the
 * version marker is unrecognized.
 */
export function assertSupportedFlueSchemaVersion(storedVersion: string): void {
	if (storedVersion === String(FLUE_SCHEMA_VERSION)) return;
	throw new PersistedSchemaVersionError({
		storedVersion,
		supportedVersion: FLUE_SCHEMA_VERSION,
	});
}

export function migrateFlueSqlSchema(sql: SqlStorage, ensureCurrentSchema: () => void): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_meta (
		 key TEXT PRIMARY KEY,
		 value TEXT NOT NULL
		)`,
	);
	const stored = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]?.value;
	if (stored !== undefined && stored !== null) assertSupportedFlueSchemaVersion(String(stored));

	repairSubmissionColumns(sql);
	repairRunColumns(sql);
	ensureCurrentSchema();

	sql.exec(
		`INSERT INTO flue_meta (key, value) VALUES ('schema_version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		String(FLUE_SCHEMA_VERSION),
	);
	const persisted = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]?.value;
	assertSupportedFlueSchemaVersion(String(persisted));
}

function repairSubmissionColumns(sql: SqlStorage): void {
	if (!tableExists(sql, 'flue_agent_submissions')) return;
	const columns = tableColumns(sql, 'flue_agent_submissions');
	if (!columns.has('terminal_event_key')) {
		sql.exec('ALTER TABLE flue_agent_submissions ADD COLUMN terminal_event_key TEXT');
	}
	if (!columns.has('terminal_event_json')) {
		sql.exec('ALTER TABLE flue_agent_submissions ADD COLUMN terminal_event_json TEXT');
	}
	if (!columns.has('terminal_event_offset')) {
		sql.exec('ALTER TABLE flue_agent_submissions ADD COLUMN terminal_event_offset TEXT');
	}
}

function repairRunColumns(sql: SqlStorage): void {
	if (!tableExists(sql, 'flue_runs')) return;
	const columns = tableColumns(sql, 'flue_runs');
	if (!columns.has('traceparent')) sql.exec('ALTER TABLE flue_runs ADD COLUMN traceparent TEXT');
	if (!columns.has('tracestate')) sql.exec('ALTER TABLE flue_runs ADD COLUMN tracestate TEXT');
}

function tableExists(sql: SqlStorage, table: string): boolean {
	return sql
		.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
		.toArray().length > 0;
}

function tableColumns(sql: SqlStorage, table: 'flue_agent_submissions' | 'flue_runs'): Set<string> {
	return new Set(sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => String(row.name)));
}
