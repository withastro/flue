import type { ConversationStreamStore } from '@flue/runtime/adapter';
import {
	ConversationStreamStoreError,
	defineSqlConversationStreamStore,
} from '@flue/runtime/adapter';
import type { MysqlParameter, MysqlRunner } from './mysql-adapter.ts';

export const MYSQL_CONVERSATION_STREAM_PATH_LIMIT = 255;

export function assertMysqlConversationStreamPath(path: string, operation: string): void {
	if (path.length > MYSQL_CONVERSATION_STREAM_PATH_LIMIT) {
		throw new ConversationStreamStoreError({
			operation,
			path,
			reason: `Stream path exceeds the supported ${MYSQL_CONVERSATION_STREAM_PATH_LIMIT}-character limit.`,
		});
	}
}

export function createMysqlConversationStreamStore(runner: MysqlRunner): ConversationStreamStore {
	return defineSqlConversationStreamStore({
		placeholder: () => '?',
		lockClause: 'FOR UPDATE',
		insertIgnorePrefix: 'INSERT IGNORE',
		insertIgnoreSuffix: '',
		supportsReturning: false,
		inlineReadLimit: true,
		validatePath: assertMysqlConversationStreamPath,
		query: (sql, params) => runner.query(sql, params as MysqlParameter[]),
		transaction: (fn) =>
			runner.transaction((tx) =>
				fn({ query: (sql, params) => tx.query(sql, params as MysqlParameter[]) }),
			),
	});
}
