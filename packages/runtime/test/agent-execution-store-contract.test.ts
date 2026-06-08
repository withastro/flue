/**
 * Shared contract tests for AgentExecutionStore.
 *
 * Runs the same behavioral assertions against both the Cloudflare-style SQL
 * backend (node:sqlite standing in for DO SQLite) and the Node backend
 * (node:sqlite :memory: via createNodeAgentExecutionStore).
 *
 * SQL-specific tests (schema assertions, error diagnostics, DO-specific edge
 * cases) remain in cloudflare-agent-execution-store.test.ts.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import type { SqlStorage } from '../src/sql-storage.ts';
import { createSqlAgentExecutionStoreFromSql, ensureSqlAgentExecutionTables } from '../src/sql-agent-execution-store.ts';
import { createNodeAgentExecutionStore, sqlite } from '../src/node/agent-execution-store.ts';
import type { SessionData } from '../src/types.ts';
import { defineStoreContractTests } from '../src/test-utils/define-store-contract-tests.ts';

// ─── Backend factories ──────────────────────────────────────────────────────

function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

function createCloudflareSqlBackend(): AgentExecutionStore {
	const db = new DatabaseSync(':memory:');
	const sql: SqlStorage = {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			let rows: Record<string, unknown>[];
			if (queryExpectsRows(query)) {
				rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
			} else {
				stmt.run(...(bindings as never[]));
				rows = [];
			}
			return { toArray: () => rows };
		},
	};
	const runTransaction = <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
	ensureSqlAgentExecutionTables(sql);
	return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
}

function createNodeBackend(): AgentExecutionStore {
	return createNodeAgentExecutionStore();
}

// ─── Contract tests (shared) ────────────────────────────────────────────────

defineStoreContractTests('AgentExecutionStore (cloudflare-sql)', {
	create: createCloudflareSqlBackend,
});

defineStoreContractTests('AgentExecutionStore (node-sqlite)', {
	create: createNodeBackend,
});

// ─── sqlite() PersistenceAdapter tests ──────────────────────────────────────

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

function dispatchInput() {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		input: { text: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId };
}

describe('sqlite() PersistenceAdapter', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			try { rmSync(dir, { recursive: true }); } catch {}
		}
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'flue-sqlite-adapter-'));
		tempDirs.push(dir);
		return dir;
	}

	it('creates the parent directory when it does not exist', () => {
		const dir = createTempDir();
		const nested = join(dir, 'nested', 'deep', 'flue.db');
		const adapter = sqlite(nested);
		adapter.migrate?.();
		adapter.connect();
		expect(existsSync(join(dir, 'nested', 'deep'))).toBe(true);
		adapter.close?.();
	});

	it('enables WAL mode for file-backed databases', () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'wal-test.db');
		const adapter = sqlite(dbPath);
		adapter.migrate?.();
		adapter.connect();
		const db = new DatabaseSync(dbPath);
		const result = db.prepare('PRAGMA journal_mode').all() as { journal_mode: string }[];
		expect(result[0]?.journal_mode).toBe('wal');
		db.close();
		adapter.close?.();
	});

	it('preserves sessions across close() and connect() cycles', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'restart-test.db');
		const adapter = sqlite(dbPath);

		adapter.migrate?.();
		const store1 = adapter.connect() as AgentExecutionStore;
		await store1.sessions.save('s1', sessionData());
		await store1.submissions.admitDispatch(dispatchInput());
		await store1.submissions.claimSubmission({ ...attempt('dispatch-1', 'attempt-1'), ownerId: 'test-owner', leaseExpiresAt: Date.now() + 30_000 });
		await store1.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
		adapter.close?.();

		adapter.migrate?.();
		const store2 = adapter.connect() as AgentExecutionStore;
		expect(await store2.sessions.load('s1')).toEqual(sessionData());
		const submission = await store2.submissions.getSubmission('dispatch-1');
		expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
		expect(await store2.submissions.hasUnsettledSubmissions()).toBe(false);
		adapter.close?.();
	});

	it('returns an in-memory store when no path is provided', async () => {
		const adapter = sqlite();
		adapter.migrate?.();
		const store = adapter.connect() as AgentExecutionStore;
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		adapter.close?.();
	});

	it('throws on empty string path', () => {
		expect(() => sqlite('')).toThrow('non-empty file path');
	});

	it('throws on whitespace-only path', () => {
		expect(() => sqlite('   ')).toThrow('non-empty file path');
	});

	it('close() is idempotent', () => {
		const adapter = sqlite();
		adapter.migrate?.();
		adapter.connect();
		adapter.close?.();
		adapter.close?.();
	});
});
