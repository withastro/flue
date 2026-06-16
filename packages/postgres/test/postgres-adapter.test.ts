/**
 * Contract tests for the Postgres persistence adapter.
 *
 * Uses PGlite (embedded Postgres in WASM) so no external server is needed.
 * Uses the shared contract test runner from @flue/runtime for behavioral
 * assertions, plus adapter-specific factory tests.
 */

import { PGlite } from '@electric-sql/pglite';
import { PersistedSchemaVersionError, type SessionData } from '@flue/runtime/adapter';
import {
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

describe('postgres() PersistenceAdapter', () => {
	it('creates a store and closes cleanly via postgres', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('loads legacy inline session images', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		const entry = {
			type: 'message' as const,
			id: 'legacy-entry',
			parentId: null,
			timestamp: '2026-06-03T00:00:00.000Z',
			message: {
				role: 'user' as const,
				content: [{ type: 'image' as const, data: 'legacy-inline-data', mimeType: 'image/png' }],
				timestamp: 0,
			},
		};
		await runner.query('INSERT INTO flue_sessions (id, data) VALUES ($1, $2)', [
			'legacy-session',
			JSON.stringify({ ...sessionData(), entries: undefined, leafId: 'legacy-entry' }),
		]);
		await runner.query(
			'INSERT INTO flue_session_entries (session_id, entry_id, position, data) VALUES ($1, $2, $3, $4)',
			['legacy-session', entry.id, 0, JSON.stringify(entry)],
		);
		expect(await store.sessions.load('legacy-session')).toEqual({
			...sessionData(),
			entries: [entry],
			leafId: 'legacy-entry',
		});
		await adapter.close?.();
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

	it('stamps a fresh database and rejects migrate() against a newer schema version', async () => {
		const runner = createPgliteRunner();
		const adapter = postgres(runner);
		await adapter.migrate?.();

		const rows = await runner.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		expect(rows).toEqual([{ value: '1' }]);

		await runner.query(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);

		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});
});
