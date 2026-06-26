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
 * Bump this when a persisted format changes incompatibly. Pre-1.0 stores with
 * another version are rejected and must be cleared.
 */
export const FLUE_SCHEMA_VERSION = 6;

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
	if (stored !== undefined && stored !== null) {
		assertSupportedFlueSchemaVersion(String(stored));
	} else {
		const existing = sql
			.exec(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'flue_%' AND name <> 'flue_meta'
				 LIMIT 1`,
			)
			.toArray()[0];
		if (existing) {
			throw new PersistedSchemaVersionError({
				storedVersion: 'unversioned',
				supportedVersion: FLUE_SCHEMA_VERSION,
			});
		}
	}

	ensureCurrentSchema();

	sql.exec(
		`INSERT INTO flue_meta (key, value) VALUES ('schema_version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		String(FLUE_SCHEMA_VERSION),
	);
	const persisted = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]?.value;
	assertSupportedFlueSchemaVersion(String(persisted));
}
