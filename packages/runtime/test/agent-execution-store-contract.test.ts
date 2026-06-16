/**
 * Shared contract tests for AgentExecutionStore.
 *
 * Runs the same behavioral assertions against both the Cloudflare-style SQL
 * backend (node:sqlite standing in for DO SQLite) and the Node backend
 * (node:sqlite :memory: via the sqlite() adapter).
 *
 * SQL-specific tests (schema assertions, error diagnostics, DO-specific edge
 * cases) remain in cloudflare-agent-execution-store.test.ts.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import { PersistedSchemaVersionError } from '../src/errors.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from '../src/sql-agent-execution-store.ts';
import type { SqlStorage } from '../src/sql-storage.ts';
import { defineStoreContractTests } from '../src/test-utils/define-store-contract-tests.ts';
import type { SessionData } from '../src/types.ts';

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

async function createNodeBackend(): Promise<AgentExecutionStore> {
	const adapter = sqlite();
	await adapter.migrate?.();
	const { executionStore } = await adapter.connect();
	return executionStore;
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

function dispatchInput() {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
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
			try {
				rmSync(dir, { recursive: true });
			} catch {}
		}
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'flue-sqlite-adapter-'));
		tempDirs.push(dir);
		return dir;
	}

	it('creates the parent directory when it does not exist', async () => {
		const dir = createTempDir();
		const nested = join(dir, 'nested', 'deep', 'flue.db');
		const adapter = sqlite(nested);
		await adapter.migrate?.();
		await adapter.connect();
		expect(existsSync(join(dir, 'nested', 'deep'))).toBe(true);
		await adapter.close?.();
	});

	it('enables WAL mode for file-backed databases', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'wal-test.db');
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		await adapter.connect();
		const db = new DatabaseSync(dbPath);
		const result = db.prepare('PRAGMA journal_mode').all() as { journal_mode: string }[];
		expect(result[0]?.journal_mode).toBe('wal');
		db.close();
		await adapter.close?.();
	});

	it('preserves sessions across close() and connect() cycles', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'restart-test.db');
		const adapter = sqlite(dbPath);

		await adapter.migrate?.();
		const { executionStore: store1 } = await adapter.connect();
		await store1.sessions.save('s1', sessionData());
		await store1.submissions.admitDispatch(dispatchInput());
		await store1.submissions.claimSubmission({
			...attempt('dispatch-1', 'attempt-1'),
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await store1.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
		await adapter.close?.();

		await adapter.migrate?.();
		const { executionStore: store2 } = await adapter.connect();
		expect(await store2.sessions.load('s1')).toEqual(sessionData());
		const submission = await store2.submissions.getSubmission('dispatch-1');
		expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
		expect(await store2.submissions.hasUnsettledSubmissions()).toBe(false);
		await adapter.close?.();
	});

	it('preserves workflow run records and run listing across close() and reconnect cycles', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'run-restart-test.db');
		const adapter = sqlite(dbPath);

		await adapter.migrate?.();
		const { runStore: runStore1 } = await adapter.connect();
		await runStore1.createRun({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			startedAt: '2026-06-03T00:00:00.000Z',
			payload: { day: 'wednesday' },
		});
		await runStore1.endRun({
			runId: 'run_01DAILYREPORT',
			endedAt: '2026-06-03T00:00:01.000Z',
			isError: false,
			durationMs: 1000,
			result: { report: 'done' },
		});
		await adapter.close?.();

		await adapter.migrate?.();
		const { runStore: runStore2 } = await adapter.connect();
		expect(await runStore2.getRun('run_01DAILYREPORT')).toMatchObject({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			status: 'completed',
			payload: { day: 'wednesday' },
			result: { report: 'done' },
		});
		expect(await runStore2.lookupRun('run_01DAILYREPORT')).toMatchObject({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			status: 'completed',
		});
		const listed = await runStore2.listRuns();
		expect(listed.runs).toHaveLength(1);
		expect(listed.runs[0]).toMatchObject({
			runId: 'run_01DAILYREPORT',
			workflowName: 'daily-report',
			status: 'completed',
		});
		await adapter.close?.();
	});

	it('returns an in-memory store when no path is provided', async () => {
		const adapter = sqlite();
		await adapter.migrate?.();
		const { executionStore: store } = await adapter.connect();
		await store.sessions.save('s1', sessionData());
		expect(await store.sessions.load('s1')).toEqual(sessionData());
		await adapter.close?.();
	});

	it('throws when the path is an empty string', () => {
		expect(() => sqlite('')).toThrow('non-empty file path');
	});

	it('throws when the path is only whitespace', () => {
		expect(() => sqlite('   ')).toThrow('non-empty file path');
	});

	it('resolves when close() is called twice', async () => {
		const adapter = sqlite();
		await adapter.migrate?.();
		await adapter.connect();
		await adapter.close?.();
		await adapter.close?.();
	});

	it('stamps a fresh database with the current schema version', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'stamp-test.db');
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		await adapter.close?.();

		const db = new DatabaseSync(dbPath);
		const rows = db.prepare(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).all() as {
			value: string;
		}[];
		expect(rows).toEqual([{ value: '1' }]);
		db.close();
	});

	it('rejects opening a database stamped with a newer schema version', async () => {
		const dir = createTempDir();
		const dbPath = join(dir, 'newer-version-test.db');
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		await adapter.close?.();

		const db = new DatabaseSync(dbPath);
		db.prepare(`UPDATE flue_meta SET value = '999' WHERE key = 'schema_version'`).run();
		db.close();

		const reopened = sqlite(dbPath);
		try {
			expect(() => reopened.migrate?.()).toThrowError(PersistedSchemaVersionError);
		} finally {
			await reopened.close?.();
		}
	});
});
