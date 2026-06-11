import type { AgentExecutionStore } from '../agent-execution-store.ts';
import type { SqlStorage } from '../sql-storage.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
	ensureSessionTable,
	type SessionAttachmentStore,
	type SqlSessionStoreOptions,
	SqlSessionStore,
} from '../sql-agent-execution-store.ts';
import type { SessionStore } from '../types.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

interface R2BucketLike {
	put(key: string, value: string, options?: unknown): Promise<unknown>;
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	delete(key: string): Promise<unknown>;
}

export function createSqlSessionStore(
	storage: DurableObjectStorage,
	options: SqlSessionStoreOptions = {},
): SessionStore {
	const sql = storage.sql;
	const transactionSync = storage.transactionSync;
	if (!sql || typeof transactionSync !== 'function') {
		throw new Error('[flue] Cloudflare workflow session persistence requires Durable Object SQLite.');
	}
	ensureSessionTable(sql);
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	return new SqlSessionStore(sql, runTransaction, options);
}

export function createR2SessionAttachmentStore(
	bucket: R2BucketLike | null | undefined,
): SessionAttachmentStore | undefined {
	if (!bucket) return undefined;
	return {
		async put(key: string, data: string): Promise<void> {
			await bucket.put(key, data, {
				httpMetadata: { contentType: 'text/plain; charset=utf-8' },
				customMetadata: { flue: 'session-attachment' },
			});
		},
		async get(key: string): Promise<string> {
			const object = await bucket.get(key);
			if (!object) throw new Error('[flue] Persisted session attachment object is missing.');
			return object.text();
		},
		async delete(key: string): Promise<void> {
			await bucket.delete(key);
		},
	};
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
	options: SqlSessionStoreOptions = {},
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
		return createSqlAgentExecutionStoreFromSql(sql, runTransaction, options);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" could not initialize its SQLite execution store. ` +
				`Underlying error: ${detail}`,
			{ cause },
		);
	}
}
