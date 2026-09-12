import { defineConversationStreamStoreContractTests } from '@flue/runtime/test-utils/conversation-stream';
import { createClient, type InValue } from '@libsql/client';
import { type LibsqlQuery, libsql } from './libsql-adapter.ts';

const clients: ReturnType<typeof createClient>[] = [];
const directories: string[] = [];
defineConversationStreamStoreContractTests('libSQL conversation store', {
	async create() {
		const directory = mkdtempSync(join(tmpdir(), 'flue-cleanup-test-'));
		directories.push(directory);
		const client = createClient({ url: `file:${join(directory, 'store.sqlite')}` });
		clients.push(client);
		let tail: Promise<unknown> = Promise.resolve();
		const serialize = <T>(work: () => Promise<T>) => {
			const next = tail.then(work, work);
			tail = next.catch(() => undefined);
			return next;
		};
		const query: LibsqlQuery = (sql, args = []) =>
			serialize(async () => (await client.execute({ sql, args: args as InValue[] })).rows);
		const adapter = libsql({
			query,
			transaction: (fn) =>
				serialize(async () => {
					const tx = await client.transaction('write');
					try {
						const result = await fn({
							query: async (sql, args = []) =>
								(await tx.execute({ sql, args: args as InValue[] })).rows,
						});
						await tx.commit();
						return result;
					} catch (error) {
						await tx.rollback();
						throw error;
					} finally {
						tx.close();
					}
				}),
			close: () => client.close(),
		});
		await adapter.migrate?.();
		const connection = await adapter.connect();
		return {
			stream: connection.conversationStreamStore,
			submissionStore: connection.submissionStore,
		};
	},
	cleanup() {
		for (const client of clients.splice(0)) client.close();
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	},
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
