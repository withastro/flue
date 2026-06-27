import type { AgentExecutionStore } from '../agent-execution-store.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from '../sql-agent-execution-store.ts';
import { ensureSqlAttachmentTable, SqliteAttachmentStore } from '../sql-attachment-store.ts';
import type { SqlStorage } from '../sql-storage.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

export function createSqlConversationStores(storage: DurableObjectStorage) {
	const sql = storage.sql as SqlStorage;
	const transactionSync = storage.transactionSync as NonNullable<DurableObjectStorage['transactionSync']>;
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	ensureSqlAttachmentTable(sql);
	return {
		conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
		attachmentStore: new SqliteAttachmentStore(sql, runTransaction),
	};
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
