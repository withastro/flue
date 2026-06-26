/**
 * Contract tests for the libSQL persistence adapter.
 *
 * Uses a `@libsql/client` over a throwaway temp-file database so no external
 * server is needed. (`url: ':memory:'` is unusable here: the local libSQL
 * driver opens a fresh in-memory database for each connection, so writes made
 * inside `client.transaction(...)` are invisible to top-level `client.execute`
 * — a per-test temp file is the smallest backing store that shares state across
 * the transaction and non-transaction connections.) Uses the shared contract
 * test runner from @flue/runtime for behavioral assertions, plus
 * adapter-specific factory tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistedSchemaVersionError, type SessionData } from '@flue/runtime/adapter';
import {
	defineConversationStreamStoreContractTests,
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import {
	type LibsqlParameter,
	type LibsqlQuery,
	type LibsqlRunner,
	libsql,
} from '../src/libsql-adapter.ts';

// ─── @libsql/client → LibsqlRunner adapter ─────────────────────────────────

function createLibsqlRunner(
	options: { path?: string; intMode?: 'number' | 'string' | 'bigint' } = {},
): LibsqlRunner {
	const dir = options.path ? undefined : mkdtempSync(join(tmpdir(), 'flue-libsql-'));
	const path = options.path ?? join(dir ?? tmpdir(), 'test.db');
	const client = createClient({ url: `file:${path}`, intMode: options.intMode });
	const toRows = (rs: {
		rows: ArrayLike<Record<string, unknown>>;
		columns: string[];
	}): Record<string, unknown>[] =>
		Array.from(rs.rows, (row) =>
			Object.fromEntries(rs.columns.map((column) => [column, row[column]])),
		);

	// The local libSQL file driver takes an immediate write lock when a
	// `write` transaction opens and returns SQLITE_BUSY (no automatic
	// queueing) if a second operation overlaps it. A real remote/Turso
	// connection or a server-backed pool serializes writers for you; here we
	// reproduce that by funneling every operation through a single promise
	// chain so transactions never overlap. This keeps the contract suite's
	// genuinely-concurrent cases (e.g. admission racing a session deletion)
	// deterministic without weakening them.
	let tail: Promise<unknown> = Promise.resolve();
	const serialize = <T>(op: () => Promise<T>): Promise<T> => {
		const run = tail.then(op, op);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	return {
		query(text: string, params: LibsqlParameter[] = []) {
			return serialize(async () => {
				const rs = await client.execute({ sql: text, args: params });
				return toRows(rs);
			});
		},
		transaction<T>(fn: (tx: { query: LibsqlQuery }) => Promise<T>): Promise<T> {
			return serialize(async () => {
				const tx = await client.transaction('write');
				try {
					const query: LibsqlQuery = async (text, params = []) => {
						const rs = await tx.execute({ sql: text, args: params });
						return toRows(rs);
					};
					const result = await fn({ query });
					await tx.commit();
					return result;
				} catch (error) {
					await tx.rollback();
					throw error;
				} finally {
					tx.close();
				}
			});
		},
		close() {
			client.close();
			if (dir) rmSync(dir, { recursive: true, force: true });
		},
	};
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

{
	let adapter: ReturnType<typeof libsql> | undefined;
	defineStoreContractTests('libSQL AgentExecutionStore', {
		async create() {
			adapter = libsql(createLibsqlRunner());
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
	let adapter: ReturnType<typeof libsql> | undefined;
	defineEventStreamStoreContractTests('libSQL EventStreamStore', {
		async create() {
			adapter = libsql(createLibsqlRunner());
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
	let adapter: ReturnType<typeof libsql> | undefined;
	defineConversationStreamStoreContractTests('libSQL ConversationStreamStore', {
		async create() {
			adapter = libsql(createLibsqlRunner());
			await adapter.migrate?.();
			const stores = await adapter.connect();
			if (!stores.conversationStreamStore || !stores.conversationSnapshotStore) {
				throw new Error('Expected libSQL conversation stores.');
			}
			return {
				stream: stores.conversationStreamStore,
				snapshots: stores.conversationSnapshotStore,
				executionStore: stores.executionStore,
			};
		},
		async cleanup() {
			await adapter?.close?.();
			adapter = undefined;
		},
	});
}

{
	let adapter: ReturnType<typeof libsql> | undefined;
	defineRunStoreContractTests('libSQL RunStore', {
		async create() {
			adapter = libsql(createLibsqlRunner());
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

function sessionData(): SessionData {
	return {
		version: 8,
		conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		childSessions: [],
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

describe('libsql() PersistenceAdapter', () => {
	it('creates a store and closes cleanly via libsql', async () => {
		const runner = createLibsqlRunner();
		const adapter = libsql(runner);
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('persists sessions across a client restart', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'flue-libsql-restart-'));
		const path = join(dir, 'test.db');
		try {
			const first = libsql(createLibsqlRunner({ path }));
			await first.migrate?.();
			const firstConnection = await first.connect();
			await firstConnection.executionStore.sessions.save('restart', sessionData());
			await first.close?.();

			const second = libsql(createLibsqlRunner({ path }));
			await second.migrate?.();
			const secondConnection = await second.connect();
			expect(await secondConnection.executionStore.sessions.load('restart')).toEqual(sessionData());
			await second.close?.();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('decodes run booleans when integer rows are strings', async () => {
		const runner = createLibsqlRunner({ intMode: 'string' });
		const adapter = libsql(runner);
		await adapter.migrate?.();
		const { runStore } = await adapter.connect();
		await runStore.createRun({
			runId: 'run-1',
			workflowName: 'workflow',
			startedAt: '2026-06-03T00:00:00.000Z',
			input: undefined,
		});
		await runStore.endRun({
			runId: 'run-1',
			endedAt: '2026-06-03T00:00:01.000Z',
			durationMs: 1_000,
			isError: false,
		});
		expect((await runStore.getRun('run-1'))?.isError).toBe(false);
		await adapter.close?.();
	});

	it('close() is idempotent', async () => {
		const runner = createLibsqlRunner();
		const adapter = libsql(runner);
		await adapter.migrate?.();
		await adapter.connect();
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
		await adapter.close();
	});

	it('stamps a fresh database and rejects migrate() against unknown and newer schema versions', async () => {
		const runner = createLibsqlRunner();
		const adapter = libsql(runner);
		await adapter.migrate?.();

		const rows = await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		expect(rows).toEqual([{ value: '5' }]);

		await runner.query(`UPDATE flue_meta SET value = '1' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await runner.query(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);

		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('rejects unversioned Flue persistence without stamping it', async () => {
		const runner = createLibsqlRunner();
		await runner.query(`CREATE TABLE flue_runs (run_id TEXT PRIMARY KEY)`);
		const adapter = libsql(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(
			await runner.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flue_meta'`),
		).toEqual([]);
		await adapter.close?.();
	});

	it('rejects schema v2 persistence without migrating it', async () => {
		const runner = createLibsqlRunner();
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
				is_error INTEGER,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		const adapter = libsql(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`)).toEqual([
			{ value: '2' },
		]);
		await adapter.close?.();
	});

	it('rejects schema v3 run tables without repairing them', async () => {
		const runner = createLibsqlRunner();
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
				is_error INTEGER,
				duration_ms INTEGER,
				result TEXT,
				error TEXT
			)
		`);
		const adapter = libsql(runner);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		const columns = await runner.query(`PRAGMA table_info(flue_runs)`);
		expect(columns.map((column) => column.name)).not.toEqual(
			expect.arrayContaining(['traceparent', 'tracestate']),
		);
		await adapter.close?.();
	});
});
