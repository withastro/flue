/**
 * SQL-backed `RunStore` over the generic {@link SqlStorage} interface.
 *
 * Backend-agnostic: runs against Cloudflare DO SQLite (workflow Durable
 * Objects) and `node:sqlite` (the Node `sqlite()` persistence adapter).
 * One `flue_runs` table backs records, lookups, and listings; pointers are
 * a column-subset projection of the run record.
 */

import { clampLimit } from './adapter-helpers.ts';
import {
	type CreateRunInput,
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	type EndRunInput,
	encodeRunCursor,
	type ListRunsOpts,
	type ListRunsResponse,
	MAX_LIST_LIMIT,
	type RunPointer,
	type RunRecord,
	type RunStatus,
	type RunStore,
	type WorkflowRunPointer,
} from './runtime/run-store.ts';
import { ensureFlueSchemaVersion } from './schema-version.ts';
import type { SqlStorage } from './sql-storage.ts';

type SqlRow = Record<string, unknown>;

export function createSqlRunStore(sql: SqlStorage): RunStore {
	ensureRunTables(sql);
	return new SqlRunStore(sql);
}

class SqlRunStore implements RunStore {
	constructor(private sql: SqlStorage) {}

	async createRun(input: CreateRunInput): Promise<void> {
		// Idempotent first-writer-wins: a replayed runId must never resurrect
		// a terminal record back to 'active'.
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_runs
			 (run_id, workflow_name, status, started_at, payload, ended_at, is_error, duration_ms, result, error)
			 VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
			input.runId,
			input.workflowName,
			'active',
			input.startedAt,
			serializeSqlJson(input.input),
		);
	}

	async endRun(input: EndRunInput): Promise<void> {
		this.sql.exec(
			`UPDATE flue_runs
			 SET status = ?, ended_at = ?, is_error = ?, duration_ms = ?, result = ?, error = ?
			 WHERE run_id = ?`,
			input.isError ? 'errored' : 'completed',
			input.endedAt,
			input.isError ? 1 : 0,
			input.durationMs,
			serializeSqlJson(input.result),
			serializeSqlJson(input.error),
			input.runId,
		);
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		const rows = this.sql.exec('SELECT * FROM flue_runs WHERE run_id = ?', runId).toArray();
		const row = rows[0];
		if (!row) return null;
		return rowToRunRecord(row);
	}

	async lookupRun(runId: string): Promise<WorkflowRunPointer | null> {
		const rows = this.sql
			.exec('SELECT run_id, workflow_name FROM flue_runs WHERE run_id = ?', runId)
			.toArray();
		const row = rows[0];
		return row ? { runId: String(row.run_id), workflowName: String(row.workflow_name) } : null;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const wheres: string[] = [];
		const bindings: unknown[] = [];
		if (opts.status) {
			wheres.push('status = ?');
			bindings.push(opts.status);
		}
		if (opts.workflowName) {
			wheres.push('workflow_name = ?');
			bindings.push(opts.workflowName);
		}
		if (cursor) {
			wheres.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
			bindings.push(cursor.startedAt, cursor.startedAt, cursor.runId);
		}
		const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
		const rows = this.sql
			.exec(
				`SELECT run_id, workflow_name, status, started_at, ended_at, duration_ms, is_error
			 FROM flue_runs ${where}
			 ORDER BY started_at DESC, run_id DESC LIMIT ?`,
				...bindings,
				limit + 1,
			)
			.toArray();
		const hasMore = rows.length > limit;
		const page = (hasMore ? rows.slice(0, limit) : rows).map(rowToRunPointer);
		const last = page.at(-1);
		return { runs: page, nextCursor: hasMore && last ? encodeRunCursor(last) : undefined };
	}
}

function ensureRunTables(sql: SqlStorage): void {
	ensureFlueSchemaVersion(sql);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_runs (
		 run_id TEXT PRIMARY KEY,
		 workflow_name TEXT,
		 status TEXT NOT NULL,
		 started_at TEXT NOT NULL,
		 payload TEXT,
		 ended_at TEXT,
		 is_error INTEGER,
		 duration_ms INTEGER,
		 result TEXT,
		 error TEXT
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_runs_workflow_started_idx ON flue_runs (workflow_name, started_at DESC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_runs_status_started_idx ON flue_runs (status, started_at DESC, run_id DESC)',
	);
}

function serializeSqlJson(value: unknown): string | null {
	return JSON.stringify(value) ?? null;
}

function rowToRunRecord(row: SqlRow): RunRecord {
	const input = typeof row.payload === 'string' ? JSON.parse(row.payload) : undefined;
	const result = typeof row.result === 'string' ? JSON.parse(row.result) : undefined;
	const error = typeof row.error === 'string' ? JSON.parse(row.error) : undefined;
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: row.status as RunRecord['status'],
		startedAt: String(row.started_at),
		input,
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		isError:
			row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		result,
		error,
	};
}

function rowToRunPointer(row: SqlRow): RunPointer {
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: String(row.status) as RunStatus,
		startedAt: String(row.started_at),
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		isError:
			row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
	};
}
