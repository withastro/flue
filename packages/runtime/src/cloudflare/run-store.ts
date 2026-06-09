import {
	type CreateRunInput,
	type EndRunInput,
	type RunRecord,
	type RunStore,
} from '../runtime/run-store.ts';
import type { SqlStorage } from '../sql-storage.ts';

type SqlRow = Record<string, unknown>;

export function createDurableRunStore(sql: SqlStorage): RunStore {
	ensureRunTables(sql);
	return new DurableRunStore(sql);
}

class DurableRunStore implements RunStore {
	constructor(private sql: SqlStorage) {}

	async createRun(input: CreateRunInput): Promise<void> {
		if (input.owner.instanceId !== input.runId) {
			throw new Error(
				'[flue] Workflow run owners must use the same instanceId as the run record runId.',
			);
		}
		this.sql.exec(
			`INSERT OR REPLACE INTO flue_runs
			 (run_id, owner_kind, instance_id, workflow_name, status, started_at, payload, ended_at, is_error, duration_ms, result, error)
			 VALUES (?, 'workflow', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
			input.runId,
			input.owner.instanceId,
			input.owner.workflowName,
			'active',
			input.startedAt,
			serializeSqlJson(input.payload),
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
		const rows = this.sql
			.exec("SELECT * FROM flue_runs WHERE run_id = ? AND owner_kind = 'workflow'", runId)
			.toArray();
		const row = rows[0];
		if (!row) return null;
		return rowToRunRecord(row);
	}
}

function ensureRunTables(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_runs (
		 run_id TEXT PRIMARY KEY,
		 owner_kind TEXT NOT NULL,
		 instance_id TEXT,
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
		`CREATE TABLE IF NOT EXISTS flue_run_events (
		 run_id TEXT NOT NULL,
		 event_index INTEGER NOT NULL,
		 type TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 timestamp TEXT NOT NULL,
		 PRIMARY KEY (run_id, event_index)
		)`,
	);
	sql.exec(
		`CREATE TRIGGER IF NOT EXISTS flue_runs_reset_events
		 BEFORE INSERT ON flue_runs
		 BEGIN
		  DELETE FROM flue_run_events WHERE run_id = NEW.run_id;
		 END`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_runs_instance_started_idx ON flue_runs (owner_kind, instance_id, started_at DESC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_runs_workflow_started_idx ON flue_runs (owner_kind, workflow_name, started_at DESC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_run_events_run_idx ON flue_run_events (run_id, event_index ASC)',
	);
}

function serializeSqlJson(value: unknown): string | null {
	return JSON.stringify(value) ?? null;
}

function rowToRunRecord(row: SqlRow): RunRecord {
	const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : undefined;
	const result = typeof row.result === 'string' ? JSON.parse(row.result) : undefined;
	const error = typeof row.error === 'string' ? JSON.parse(row.error) : undefined;
	const runId = String(row.run_id);
	const owner = {
		kind: 'workflow' as const,
		workflowName: String(row.workflow_name),
		instanceId: String(row.instance_id ?? runId),
	};
	return {
		runId,
		owner,
		status: row.status as RunRecord['status'],
		startedAt: String(row.started_at),
		payload,
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		isError:
			row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		result,
		error,
	};
}
