import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import { describeErrorChain, formatErrorForLog } from '../errors.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from '../sql-agent-execution-store.ts';
import { ensureSqlAttachmentTable, SqliteAttachmentStore } from '../sql-attachment-store.ts';
import { createSqlInstanceMaintenance } from '../sql-instance-maintenance.ts';
import type { SqlStorage } from '../sql-storage.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

/**
 * Wrap a store-initialization failure so it survives the Durable Object
 * boundary. These wrappers run in the DO constructor: the throw tunnels
 * across `stub.fetch()` message-only, so the full cause chain is flattened
 * into the message, and the real error — stacks and all — is logged DO-side
 * first. That log line is the only place the original stack ever exists, and
 * the only coverage for alarm-driven wakes that have no HTTP caller at all.
 * The constructor-throw semantics stay: a DO that cannot open its storage
 * fails loudly and lets the platform re-instantiate on the next request.
 */
function initFailure(className: string, what: string, cause: unknown): Error {
	const wrapped = new Error(
		`[flue] Cloudflare durable agent class "${className}" could not initialize its ${what}. ` +
			`Underlying error: ${describeErrorChain(cause)}`,
		{ cause },
	);
	console.error(formatErrorForLog(wrapped));
	return wrapped;
}

export function createSqlConversationStores(storage: DurableObjectStorage, className: string) {
	const sql = storage.sql as SqlStorage;
	const transactionSync = storage.transactionSync as NonNullable<
		DurableObjectStorage['transactionSync']
	>;
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	try {
		ensureSqlAttachmentTable(sql);
		return {
			conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
			attachmentStore: new SqliteAttachmentStore(sql, runTransaction),
			instanceMaintenance: createSqlInstanceMaintenance(sql, runTransaction),
		};
	} catch (cause) {
		throw initFailure(className, 'SQLite conversation stores', cause);
	}
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): AgentSubmissionStore {
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
		throw initFailure(className, 'SQLite execution store', cause);
	}
}
