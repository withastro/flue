/**
 * Node agent execution store and built-in SQLite persistence adapter.
 *
 * Uses the same SQL store implementation as Cloudflare (DO SQLite) but runs
 * against `node:sqlite`'s `DatabaseSync`. Pass `:memory:` (default) for
 * process-lifetime storage, or a file path for persistent storage.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PersistenceAdapter } from '../agent-execution-store.ts';
import type { SqlStorage } from '../sql-storage.ts';
import { createSqlRunRegistry } from '../sql-run-registry.ts';
import { createSqlRunStore } from '../sql-run-store.ts';
import { SqliteEventStreamStore } from '../runtime/event-stream-store.ts';
import { createSqlAgentExecutionStoreFromSql, ensureSqlAgentExecutionTables } from '../sql-agent-execution-store.ts';

/**
 * Adapt `node:sqlite` {@link DatabaseSync} to the Cloudflare {@link SqlStorage}
 * shape expected by the shared SQL store implementation.
 *
 * `node:sqlite`'s `.all()` only works for statements that return rows (SELECT,
 * INSERT/UPDATE...RETURNING). Write-only statements (CREATE, INSERT, UPDATE
 * without RETURNING) must use `.run()` instead. We distinguish by checking
 * whether the query expects result rows.
 */
function createNodeSqlStorage(db: DatabaseSync): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			const expectsRows = queryExpectsRows(query);
			let rows: Record<string, unknown>[];
			if (expectsRows) {
				rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
			} else {
				stmt.run(...(bindings as never[]));
				rows = [];
			}
			return {
				toArray() {
					return rows;
				},
			};
		},
	};
}

/** Check whether a SQL query is expected to return result rows. */
function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

/**
 * Create an in-memory transaction wrapper for `node:sqlite`.
 */
function createNodeTransactionSync(db: DatabaseSync): <T>(closure: () => T) => T {
	return <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
}

/** Open a `node:sqlite` database and return the handle, SQL adapter, and transaction wrapper. */
function openDatabase(path: string): { db: DatabaseSync; sql: SqlStorage; runTransaction: <T>(closure: () => T) => T } {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new DatabaseSync(path);
	if (path !== ':memory:') {
		db.exec('PRAGMA journal_mode=WAL');
	}
	const sql = createNodeSqlStorage(db);
	const runTransaction = createNodeTransactionSync(db);
	return { db, sql, runTransaction };
}

/**
 * Built-in SQLite persistence adapter for Node.js.
 *
 * @param path - SQLite database file path. Omit or pass `':memory:'` for an
 *   in-memory database (data lost on process exit). Pass a file path for
 *   persistent storage across restarts.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { sqlite } from '@flue/runtime/node';
 * export default sqlite('./data/flue.db');
 * ```
 */
export function sqlite(path?: string): PersistenceAdapter {
	if (path !== undefined && path !== ':memory:' && path.trim() === '') {
		throw new Error('[flue] sqlite() requires a non-empty file path, or omit the argument for an in-memory database.');
	}
	const resolvedPath = path ?? ':memory:';
	let state: ReturnType<typeof openDatabase> | undefined;

	function ensureOpen() {
		if (!state) state = openDatabase(resolvedPath);
		return state;
	}

	return {
		migrate() {
			ensureSqlAgentExecutionTables(ensureOpen().sql);
		},
		connect() {
			const { sql, runTransaction } = ensureOpen();
			return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
		},
		connectRunStore() {
			return createSqlRunStore(ensureOpen().sql);
		},
		connectRunRegistry() {
			return createSqlRunRegistry(ensureOpen().sql);
		},
		connectEventStreamStore() {
			return new SqliteEventStreamStore(ensureOpen().sql);
		},
		close() {
			state?.db.close();
			state = undefined;
		},
	};
}
