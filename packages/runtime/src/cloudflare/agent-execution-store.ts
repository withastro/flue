import type { AgentExecutionStore } from '../agent-execution-store.ts';
import {
	SqliteConversationSnapshotStore,
	SqliteConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import { migrateFlueSqlSchema } from '../schema-version.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSessionTable,
	ensureSqlAgentExecutionTables,
	SqlSessionStore,
} from '../sql-agent-execution-store.ts';
import { ensureSqlPersistedChunkTable } from '../sql-persisted-chunk-store.ts';
import type { SqlStorage } from '../sql-storage.ts';
import type { SessionStore } from '../types.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

export function createSqlConversationStores(storage: DurableObjectStorage | undefined) {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof transactionSync !== 'function') {
		throw new Error('[flue] Cloudflare canonical conversation persistence requires Durable Object SQLite.');
	}
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	return {
		conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
		conversationSnapshotStore: new SqliteConversationSnapshotStore(sql, runTransaction),
	};
}

export function createSqlSessionStore(storage: DurableObjectStorage): SessionStore {
	const sql = storage.sql;
	const transactionSync = storage.transactionSync;
	if (!sql || typeof transactionSync !== 'function') {
		throw new Error(
			'[flue] Cloudflare workflow session persistence requires Durable Object SQLite.',
		);
	}
	migrateFlueSqlSchema(sql, () => {
		ensureSessionTable(sql);
		ensureSqlPersistedChunkTable(sql);
	});
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	return new SqlSessionStore(sql, runTransaction);
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): AgentExecutionStore {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof sql.exec !== 'function' || typeof transactionSync !== 'function') {
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
				`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
				`do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ` +
				`to SQLite in place.`,
		);
	}
	try {
		ensureSqlAgentExecutionTables(sql);
		const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
		return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" could not initialize its SQLite execution store. ` +
				`Underlying error: ${detail}`,
			{ cause },
		);
	}
}
