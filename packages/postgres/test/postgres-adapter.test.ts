/**
 * Contract tests for the Postgres persistence adapter.
 *
 * Uses PGlite (embedded Postgres in WASM) so no external server is needed.
 * Uses the shared contract test runner from @flue/runtime for behavioral
 * assertions, plus adapter-specific factory tests.
 */

import { PGlite } from '@electric-sql/pglite';
import { PersistedSchemaVersionError } from '@flue/runtime/adapter';
import {
	defineAttachmentStoreContractTests,
	defineConversationStreamStoreContractTests,
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { describe, expect, it } from 'vitest';
import {
	type PostgresParameter,
	type PostgresQuery,
	type PostgresRunner,
	postgres,
} from '../src/postgres-adapter.ts';

// ─── PGlite → PostgresRunner adapter ───────────────────────────────────────

function createPgliteRunner(): PostgresRunner {
	const db = new PGlite();
	return {
		async query(text: string, params: PostgresParameter[] = []) {
			const result = await db.query(text, params);
			return (result.rows ?? []) as Record<string, unknown>[];
		},
		transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T> {
			return db.transaction(async (pgTx) => {
				const query: PostgresQuery = async (text, params = []) => {
					const result = await pgTx.query(text, params);
					return (result.rows ?? []) as Record<string, unknown>[];
				};
				return fn({ query });
			});
		},
		async close() {
			await db.close();
		},
	};
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

{
	let adapter: ReturnType<typeof postgres> | undefined;
	defineStoreContractTests('Postgres AgentExecutionStore', {
		async create() {
			adapter = postgres(createPgliteRunner());
			await adapter.migrate?.();
			const { executionStore } = await adapter.connect();
			return executionStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgres> | undefined;
	defineEventStreamStoreContractTests('Postgres EventStreamStore', {
		async create() {
			adapter = postgres(createPgliteRunner());
			await adapter.migrate?.();
			const { eventStreamStore } = await adapter.connect();
			return eventStreamStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgres> | undefined;
	defineAttachmentStoreContractTests('Postgres AttachmentStore', {
		async create() {
			adapter = postgres(createPgliteRunner());
			await adapter.migrate?.();
			return (await adapter.connect()).attachmentStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgres> | undefined;
	defineConversationStreamStoreContractTests('Postgres ConversationStreamStore', {
		async create() {
			adapter = postgres(createPgliteRunner());
			await adapter.migrate?.();
			const stores = await adapter.connect();
			if (!stores.conversationStreamStore || !stores.conversationSnapshotStore) {
				throw new Error('Expected Postgres conversation stores.');
			}
			return {
				stream: stores.conversationStreamStore,
				snapshots: stores.conversationSnapshotStore,
			};
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof postgres> | undefined;
	defineRunStoreContractTests('Postgres RunStore', {
		async create() {
			adapter = postgres(createPgliteRunner());
			await adapter.migrate?.();
			const { runStore } = await adapter.connect();
			return runStore;
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

// ─── Adapter factory tests ──────────────────────────────────────────────────

describe('postgres() PersistenceAdapter', () => {
	it('creates a store and closes cleanly via postgres', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();
		await adapter.connect();
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('close() is idempotent', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();
		await adapter.connect();
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
		await adapter.close();
	});

	it('stamps a fresh database and rejects migrate() against unknown and newer schema versions', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();

		const rows = await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		expect(rows).toEqual([{ value: '6' }]);

		await runner.query(`UPDATE flue_meta SET value = '1' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await runner.query(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);

		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('rejects unversioned Flue persistence without stamping it', async () => {
		const runner = createPgliteRunner();
		await runner.query(`CREATE TABLE flue_runs (run_id TEXT PRIMARY KEY)`);
		const adapter = postgres(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(
			await runner.query(`SELECT table_name FROM information_schema.tables WHERE table_name = 'flue_meta'`),
		).toEqual([]);
		await adapter.close?.();
	});

	it('rejects schema v2 persistence without migrating it', async () => {
		const runner = createPgliteRunner();
		await runner.query(`CREATE TABLE flue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		await runner.query(`INSERT INTO flue_meta (key, value) VALUES ('schema_version', '2')`);
		await runner.query(`
			CREATE TABLE flue_runs (
				run_id TEXT PRIMARY KEY,
				workflow_name TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				payload TEXT,
				ended_at TEXT,
				is_error BOOLEAN,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		const adapter = postgres(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`)).toEqual([
			{ value: '2' },
		]);
		await adapter.close?.();
	});

	it('rejects schema v3 run tables without repairing them', async () => {
		const runner = createPgliteRunner();
		await runner.query(`CREATE TABLE flue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		await runner.query(`INSERT INTO flue_meta (key, value) VALUES ('schema_version', '3')`);
		await runner.query(`
			CREATE TABLE flue_runs (
				run_id TEXT PRIMARY KEY,
				workflow_name TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT NOT NULL,
				payload TEXT,
				ended_at TEXT,
				is_error BOOLEAN,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		const adapter = postgres(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		const columns = await runner.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'flue_runs' AND column_name IN ('traceparent', 'tracestate')`,
		);
		expect(columns).toEqual([]);
		await adapter.close?.();
	});
});
