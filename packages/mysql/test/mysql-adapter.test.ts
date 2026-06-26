import { PersistedSchemaVersionError, type SessionData } from '@flue/runtime/adapter';
import {
	defineConversationStreamStoreContractTests,
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import mysql2, { type Pool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { type MysqlQuery, type MysqlRunner, mysql } from '../src/mysql-adapter.ts';

const mysqlUrl = process.env.TEST_MYSQL_URL;
const describeMysql = mysqlUrl ? describe : describe.skip;

function queryRows(result: unknown): Record<string, unknown>[] {
	return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

async function createMysqlRunner(): Promise<{ runner: MysqlRunner; pool: Pool; database: string }> {
	if (!mysqlUrl) throw new Error('TEST_MYSQL_URL is required.');
	const database = `flue_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const admin = mysql2.createPool(mysqlUrl);
	await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
	await admin.end();
	const url = new URL(mysqlUrl);
	url.pathname = `/${database}`;
	const pool = mysql2.createPool(url.toString());
	const query: MysqlQuery = async (text, params = []) => {
		const [rows] = await pool.execute(text, params);
		return queryRows(rows);
	};
	const runner: MysqlRunner = {
		query,
		async transaction<T>(fn: (tx: { query: MysqlQuery }) => Promise<T>): Promise<T> {
			const connection = await pool.getConnection();
			try {
				await connection.beginTransaction();
				const result = await fn({
					query: async (text, params = []) => {
						const [rows] = await connection.execute(text, params);
						return queryRows(rows);
					},
				});
				await connection.commit();
				return result;
			} catch (error) {
				await connection.rollback();
				throw error;
			} finally {
				connection.release();
			}
		},
		async close() {
			await pool.end();
			const cleanup = mysql2.createPool(mysqlUrl);
			await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``);
			await cleanup.end();
		},
	};
	return { runner, pool, database };
}

function defineContracts(): void {
	{
		let adapter: ReturnType<typeof mysql> | undefined;
		defineStoreContractTests('MySQL AgentExecutionStore', {
			async create() {
				adapter = mysql((await createMysqlRunner()).runner);
				await adapter.migrate?.();
				return (await adapter.connect()).executionStore;
			},
			async cleanup() {
				await adapter?.close?.();
				adapter = undefined;
			},
		});
	}
	{
		let adapter: ReturnType<typeof mysql> | undefined;
		defineRunStoreContractTests('MySQL RunStore', {
			async create() {
				adapter = mysql((await createMysqlRunner()).runner);
				await adapter.migrate?.();
				return (await adapter.connect()).runStore;
			},
			async cleanup() {
				await adapter?.close?.();
				adapter = undefined;
			},
		});
	}
	{
		let adapter: ReturnType<typeof mysql> | undefined;
		defineConversationStreamStoreContractTests('MySQL ConversationStreamStore', {
			async create() {
				adapter = mysql((await createMysqlRunner()).runner);
				await adapter.migrate?.();
				const stores = await adapter.connect();
				if (!stores.conversationStreamStore || !stores.conversationSnapshotStore) {
					throw new Error('Expected MySQL conversation stores.');
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
		let adapter: ReturnType<typeof mysql> | undefined;
		defineEventStreamStoreContractTests('MySQL EventStreamStore', {
			async create() {
				adapter = mysql((await createMysqlRunner()).runner);
				await adapter.migrate?.();
				return (await adapter.connect()).eventStreamStore;
			},
			async cleanup() {
				await adapter?.close?.();
				adapter = undefined;
			},
		});
	}
}

describeMysql('MySQL contracts', defineContracts);

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

describeMysql('mysql()', () => {
	it('persists sessions and closes idempotently when a backend is available', async () => {
		const adapter = mysql((await createMysqlRunner()).runner);
		await adapter.migrate?.();
		const store = (await adapter.connect()).executionStore;
		await store.sessions.save('session', sessionData());
		expect(await store.sessions.load('session')).toEqual(sessionData());
		await adapter.close?.();
		await adapter.close?.();
	});

	it('rejects a newer schema version before changing existing schema when a backend is available', async () => {
		const { runner } = await createMysqlRunner();
		const adapter = mysql(runner);
		await adapter.migrate?.();
		await runner.query(`UPDATE flue_meta SET value = '999' WHERE \`key\` = 'schema_version'`);
		await runner.query('DROP TABLE flue_event_stream_entries');
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		const rows = await runner.query(
			`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_event_stream_entries'`,
		);
		expect(rows).toEqual([]);
		await adapter.close?.();
	});

	it('rejects schema v2 persistence without migrating it when a backend is available', async () => {
		const { runner } = await createMysqlRunner();
		const adapter = mysql(runner);
		await adapter.migrate?.();
		await runner.query('ALTER TABLE flue_runs DROP COLUMN traceparent, DROP COLUMN tracestate');
		await runner.query(`UPDATE flue_meta SET value = '2' WHERE \`key\` = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		const columns = await runner.query(
			`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_runs' AND COLUMN_NAME IN ('traceparent', 'tracestate')`,
		);
		expect(columns).toEqual([]);
		const versions = await runner.query(`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`);
		expect(versions).toEqual([{ value: '2' }]);
		await adapter.close?.();
	});

	it('rejects schema v3 run tracing columns without repairing them when a backend is available', async () => {
		const { runner } = await createMysqlRunner();
		const adapter = mysql(runner);
		await adapter.migrate?.();
		await runner.query('ALTER TABLE flue_runs DROP COLUMN traceparent, DROP COLUMN tracestate');
		await runner.query(`UPDATE flue_meta SET value = '3' WHERE \`key\` = 'schema_version'`);
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		const columns = await runner.query(
			`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_runs' AND COLUMN_NAME IN ('traceparent', 'tracestate')`,
		);
		expect(columns).toEqual([]);
		await adapter.close?.();
	});

	it('uses InnoDB and binary collations for bounded key columns when a backend is available', async () => {
		const { runner } = await createMysqlRunner();
		const adapter = mysql(runner);
		await adapter.migrate?.();
		const engines = await runner.query(
			`SELECT DISTINCT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'flue\\_%'`,
		);
		expect(engines).toEqual([{ engine: 'InnoDB' }]);
		const columns = await runner.query(
			`SELECT COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flue_agent_submissions' AND COLUMN_NAME IN ('submission_id', 'session_key')`,
		);
		expect(columns.every((row) => row.collation_name === 'utf8mb4_bin')).toBe(true);
		await adapter.close?.();
	});

	it('allows only one concurrent conditional claim when a backend is available', async () => {
		const adapter = mysql((await createMysqlRunner()).runner);
		await adapter.migrate?.();
		const submissions = (await adapter.connect()).executionStore.submissions;
		await submissions.admitDirect({
			kind: 'direct',
			submissionId: 'concurrent-claim',
			agent: 'assistant',
			id: 'agent-1',
			payload: { message: 'Hello' },
			acceptedAt: '2026-06-03T00:00:00.000Z',
		});
		const claims = await Promise.all([
			submissions.claimSubmission({
				submissionId: 'concurrent-claim',
				attemptId: 'attempt-1',
				ownerId: 'owner-1',
				leaseExpiresAt: Date.now() + 30_000,
			}),
			submissions.claimSubmission({
				submissionId: 'concurrent-claim',
				attemptId: 'attempt-2',
				ownerId: 'owner-2',
				leaseExpiresAt: Date.now() + 30_000,
			}),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await adapter.close?.();
	});

	it('reports exactly one winning concurrent stream segment insertion when a backend is available', async () => {
		const adapter = mysql((await createMysqlRunner()).runner);
		await adapter.migrate?.();
		const submissions = (await adapter.connect()).executionStore.submissions;
		const results = await Promise.all([
			submissions.appendStreamChunkSegment('concurrent-stream', 0, 'same body'),
			submissions.appendStreamChunkSegment('concurrent-stream', 0, 'same body'),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(results.filter((result) => !result)).toHaveLength(1);
		await adapter.close?.();
	});

	it('rejects malformed existing submissions schema without stamping when a backend is available', async () => {
		const { runner } = await createMysqlRunner();
		const adapter = mysql(runner);
		await runner.query(
			`CREATE TABLE flue_agent_submissions (sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, submission_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload LONGTEXT NOT NULL, status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, accepted_at BIGINT NOT NULL, attempt_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, input_applied_at BIGINT, recovery_requested_at BIGINT, started_at BIGINT, settled_at BIGINT, error LONGTEXT, attempt_count INT NOT NULL DEFAULT 0, max_retry INT NOT NULL DEFAULT 10, timeout_at BIGINT NOT NULL DEFAULT 0, owner_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, lease_expires_at BIGINT NOT NULL DEFAULT 0, INDEX flue_agent_submissions_status_sequence_idx (status, sequence), INDEX flue_agent_submissions_session_status_sequence_idx (session_key, status, sequence)) ENGINE=InnoDB`,
		);
		await expect(adapter.migrate?.()).rejects.toThrowError(/submission_id/);
		const rows = await runner.query(`SELECT value FROM flue_meta WHERE \`key\` = 'schema_version'`);
		expect(rows).toEqual([]);
		await adapter.close?.();
	});
});
