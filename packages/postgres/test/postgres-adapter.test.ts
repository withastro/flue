/**
 * Contract tests for the Postgres persistence adapter.
 *
 * Uses PGlite (embedded Postgres in WASM) so no external server is needed.
 * Uses the shared contract test runner from @flue/runtime for behavioral
 * assertions, plus adapter-specific factory tests.
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vite-plus/test';
import type { SessionData } from '@flue/runtime';
import { postgresFromRunner, type PgRunner } from '../src/postgres-adapter.ts';
import { defineStoreContractTests } from '@flue/runtime/test-utils';

// ─── PGlite → PgRunner adapter ─────────────────────────────────────────────

function createPgliteRunner(): PgRunner {
	const db = new PGlite();
	return {
		async query(text: string, params: unknown[] = []) {
			const result = await db.query(text, params);
			return (result.rows ?? []) as Record<string, unknown>[];
		},
		async transaction<T>(fn: (tx: PgRunner) => Promise<T>): Promise<T> {
			return db.transaction(async (pgTx) => {
				const txRunner: PgRunner = {
					async query(text: string, params: unknown[] = []) {
						const result = await pgTx.query(text, params);
						return (result.rows ?? []) as Record<string, unknown>[];
					},
					transaction: () => {
						throw new Error('Nested transactions not supported');
					},
					close: () => Promise.resolve(),
				};
				return fn(txRunner);
			});
		},
		async close() {
			await db.close();
		},
	};
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

defineStoreContractTests('Postgres AgentExecutionStore', {
	async create() {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();
		return adapter.connect();
	},
});

// ─── Adapter factory tests ──────────────────────────────────────────────────

function sessionData(): SessionData {
	return {
		version: 5,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

describe('postgres() PersistenceAdapter', () => {
	it('creates a store and closes cleanly via postgresFromRunner', async () => {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();
		const store = adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
	});

	it('close() is idempotent', async () => {
		const runner = createPgliteRunner();
		const adapter = postgresFromRunner(runner);
		await adapter.migrate?.();
		adapter.connect();
		if (!adapter.close) throw new Error('Expected adapter.close to be defined.');
		await adapter.close();
		await adapter.close();
	});
});
