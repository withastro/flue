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
		version: 6,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		taskSessions: [],
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
			payload: undefined,
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

	it('stamps a fresh database and rejects migrate() against a newer schema version', async () => {
		const runner = createLibsqlRunner();
		const adapter = libsql(runner);
		await adapter.migrate?.();

		const rows = await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		expect(rows).toEqual([{ value: '1' }]);

		await runner.query(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);

		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});
});
