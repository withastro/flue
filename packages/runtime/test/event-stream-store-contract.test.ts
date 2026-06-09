import { DatabaseSync } from 'node:sqlite';
import { defineEventStreamStoreContractTests } from '../src/test-utils/define-event-stream-store-contract-tests.ts';
import { SqliteEventStreamStore } from '../src/runtime/event-stream-store.ts';

function createStore() {
	const db = new DatabaseSync(':memory:');
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

defineEventStreamStoreContractTests('SqliteEventStreamStore', {
	create: createStore,
});
