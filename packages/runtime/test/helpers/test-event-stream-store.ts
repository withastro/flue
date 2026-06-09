import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStreamStore } from '../../src/runtime/event-stream-store.ts';

/**
 * In-memory SQLite-backed event stream store for tests, wrapping
 * `node:sqlite` DatabaseSync in the minimal SqlStorage surface that
 * SqliteEventStreamStore expects.
 */
export function createTestEventStreamStore(
	db = new DatabaseSync(':memory:'),
): SqliteEventStreamStore {
	return new SqliteEventStreamStore({
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			if (/^\s*(SELECT|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
				return { toArray: () => stmt.all(...(bindings as never[])) as Record<string, unknown>[] };
			}
			stmt.run(...(bindings as never[]));
			return { toArray: () => [] as Record<string, unknown>[] };
		},
	});
}
