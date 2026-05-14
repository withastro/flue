import {
	type CreateRunInput,
	DEFAULT_MAX_COMPLETED_RUNS,
	DEFAULT_MAX_EVENT_BYTES,
	type EndRunInput,
	type RunRecord,
	type RunStore,
	type RunStoreOptions,
	truncateEventForPersistence,
} from '../runtime/run-store.ts';
import type { FlueEvent } from '../types.ts';

interface SqlResult {
	toArray(): SqlRow[];
}

type SqlRow = Record<string, unknown>;

interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

export function createDurableRunStore(sql: SqlStorage, options: RunStoreOptions = {}): RunStore {
	ensureRunTables(sql);
	return new DurableRunStore(sql, options);
}

class DurableRunStore implements RunStore {
	private maxCompletedRuns: number;
	private maxEventBytes: number;

	constructor(
		private sql: SqlStorage,
		options: RunStoreOptions,
	) {
		this.maxCompletedRuns = options.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS;
		this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
	}

	async createRun(input: CreateRunInput): Promise<void> {
		this.sql.exec(
			`INSERT OR REPLACE INTO flue_runs
			 (run_id, instance_id, agent_name, status, started_at, ended_at, is_error, duration_ms, result, error)
			 VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
			input.runId,
			input.instanceId,
			input.agentName,
			'active',
			input.startedAt,
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
			JSON.stringify(input.result ?? null),
			JSON.stringify(input.error ?? null),
			input.runId,
		);
		this.pruneCompletedRuns();
	}

	async appendEvent(runId: string, event: FlueEvent): Promise<void> {
		const storedEvent = truncateEventForPersistence(event, this.maxEventBytes);
		this.sql.exec(
			`INSERT OR REPLACE INTO flue_run_events
			 (run_id, event_index, type, payload, timestamp)
			 VALUES (?, ?, ?, ?, ?)`,
			runId,
			storedEvent.eventIndex ?? 0,
			storedEvent.type,
			JSON.stringify(storedEvent),
			storedEvent.timestamp ?? new Date().toISOString(),
		);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		const rows = this.sql
			.exec(
				fromIndex === undefined
					? 'SELECT payload FROM flue_run_events WHERE run_id = ? ORDER BY event_index ASC'
					: 'SELECT payload FROM flue_run_events WHERE run_id = ? AND event_index >= ? ORDER BY event_index ASC',
				...(fromIndex === undefined ? [runId] : [runId, fromIndex]),
			)
			.toArray();
		return rows.flatMap((row) => (typeof row.payload === 'string' ? [JSON.parse(row.payload)] : []));
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		const rows = this.sql.exec('SELECT * FROM flue_runs WHERE run_id = ?', runId).toArray();
		const row = rows[0];
		if (!row) return null;
		return rowToRunRecord(row);
	}

	private pruneCompletedRuns(): void {
		const rows = this.sql
			.exec(
				`SELECT run_id FROM flue_runs
				 WHERE status != 'active'
				 ORDER BY started_at ASC`,
			)
			.toArray();
		const deleteCount = rows.length - this.maxCompletedRuns;
		if (deleteCount <= 0) return;
		for (const row of rows.slice(0, deleteCount)) {
			this.sql.exec('DELETE FROM flue_run_events WHERE run_id = ?', row.run_id);
			this.sql.exec('DELETE FROM flue_runs WHERE run_id = ?', row.run_id);
		}
	}
}

function ensureRunTables(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_runs (
		 run_id TEXT PRIMARY KEY,
		 instance_id TEXT NOT NULL,
		 agent_name TEXT NOT NULL,
		 status TEXT NOT NULL,
		 started_at TEXT NOT NULL,
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
	sql.exec('CREATE INDEX IF NOT EXISTS flue_runs_instance_started_idx ON flue_runs (instance_id, started_at DESC)');
	sql.exec('CREATE INDEX IF NOT EXISTS flue_run_events_run_idx ON flue_run_events (run_id, event_index ASC)');
}

function rowToRunRecord(row: SqlRow): RunRecord {
	const result = typeof row.result === 'string' ? JSON.parse(row.result) : undefined;
	const error = typeof row.error === 'string' ? JSON.parse(row.error) : undefined;
	return {
		runId: String(row.run_id),
		instanceId: String(row.instance_id),
		agentName: String(row.agent_name),
		status: row.status as RunRecord['status'],
		startedAt: String(row.started_at),
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		isError: row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		result,
		error,
	};
}
