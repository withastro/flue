/** SQL-backed workflow-run registry operations and private REST router. */
import {
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	encodeRunCursor,
	type ListRunsOpts,
	type ListRunsResponse,
	MAX_LIST_LIMIT,
	type RecordRunEndInput,
	type RecordRunStartInput,
	type RunPointer,
} from '../runtime/run-registry.ts';
import type { RunStatus } from '../runtime/run-store.ts';

interface SqlResult {
	toArray(): SqlRow[];
}
type SqlRow = Record<string, unknown>;
export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface RegistryOps {
	recordRunStart(input: RecordRunStartInput): void;
	recordRunEnd(input: RecordRunEndInput): void;
	lookupRun(runId: string): RunPointer | null;
	listRuns(opts: ListRunsOpts): ListRunsResponse;
}

export function createRegistryOps(sql: SqlStorage): RegistryOps {
	ensureRegistryTables(sql);
	return new SqlRegistryOps(sql);
}

export async function handleRegistryRequest(ops: RegistryOps, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const segments = url.pathname.split('/').filter(Boolean);
	try {
		if (request.method === 'GET' && segments[0] === 'pointers' && segments.length === 2) {
			const runId = decodeURIComponent(segments[1] ?? '');
			if (!runId) return new Response('Missing runId.', { status: 404 });
			const pointer = ops.lookupRun(runId);
			if (!pointer) return new Response(null, { status: 404 });
			return jsonResponse(pointer);
		}
		if (
			request.method === 'POST' &&
			segments[0] === 'pointers' &&
			segments[2] === 'start' &&
			segments.length === 3
		) {
			const runId = decodeURIComponent(segments[1] ?? '');
			if (!runId) return new Response('Missing runId.', { status: 404 });
			const body = (await request.json()) as Omit<RecordRunStartInput, 'runId'>;
			ops.recordRunStart({ ...body, runId });
			return new Response(null, { status: 204 });
		}
		if (
			request.method === 'POST' &&
			segments[0] === 'pointers' &&
			segments[2] === 'end' &&
			segments.length === 3
		) {
			const runId = decodeURIComponent(segments[1] ?? '');
			if (!runId) return new Response('Missing runId.', { status: 404 });
			const body = (await request.json()) as Omit<RecordRunEndInput, 'runId'>;
			ops.recordRunEnd({ ...body, runId });
			return new Response(null, { status: 204 });
		}
		if (request.method === 'GET' && segments[0] === 'pointers' && segments.length === 1) {
			return jsonResponse(ops.listRuns(parseListRunsOpts(url.searchParams)));
		}
		return new Response(`Unknown registry endpoint: ${request.method} ${url.pathname}`, {
			status: 404,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: jsonHeaders(),
		});
	}
}

class SqlRegistryOps implements RegistryOps {
	constructor(private sql: SqlStorage) {}

	recordRunStart(input: RecordRunStartInput): void {
		if (input.owner.instanceId !== input.runId) {
			throw new Error(
				'[flue] Workflow run owners must use the same instanceId as the pointer runId.',
			);
		}
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_registry_runs
			 (run_id, owner_kind, instance_id, workflow_name, status, started_at, ended_at, duration_ms, is_error)
			 VALUES (?, 'workflow', ?, ?, 'active', ?, NULL, NULL, NULL)`,
			input.runId,
			input.owner.instanceId,
			input.owner.workflowName,
			input.startedAt,
		);
	}

	recordRunEnd(input: RecordRunEndInput): void {
		this.sql.exec(
			`UPDATE flue_registry_runs
			 SET status = ?, ended_at = ?, duration_ms = ?, is_error = ?
			 WHERE run_id = ? AND owner_kind = 'workflow'`,
			input.isError ? 'errored' : 'completed',
			input.endedAt,
			input.durationMs,
			input.isError ? 1 : 0,
			input.runId,
		);
	}

	lookupRun(runId: string): RunPointer | null {
		const row = this.sql
			.exec("SELECT * FROM flue_registry_runs WHERE run_id = ? AND owner_kind = 'workflow'", runId)
			.toArray()[0];
		return row ? rowToRunPointer(row) : null;
	}

	listRuns(opts: ListRunsOpts): ListRunsResponse {
		const limit = clampLimit(opts.limit);
		const cursor = decodeRunCursor(opts.cursor);
		const wheres: string[] = ["owner_kind = 'workflow'"];
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
		const rows = this.sql
			.exec(
				`SELECT * FROM flue_registry_runs WHERE ${wheres.join(' AND ')}
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

function ensureRegistryTables(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_registry_runs (
		 run_id TEXT PRIMARY KEY,
		 owner_kind TEXT NOT NULL,
		 instance_id TEXT,
		 workflow_name TEXT,
		 status TEXT NOT NULL,
		 started_at TEXT NOT NULL,
		 ended_at TEXT,
		 duration_ms INTEGER,
		 is_error INTEGER
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_registry_status_started_idx ON flue_registry_runs (status, started_at DESC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_registry_workflow_started_idx ON flue_registry_runs (owner_kind, workflow_name, started_at DESC)',
	);
}

function rowToRunPointer(row: SqlRow): RunPointer {
	const runId = String(row.run_id);
	return {
		runId,
		owner: {
			kind: 'workflow',
			workflowName: String(row.workflow_name),
			instanceId: String(row.instance_id ?? runId),
		},
		status: String(row.status) as RunStatus,
		startedAt: String(row.started_at),
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		isError:
			row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
	};
}

function parseListRunsOpts(params: URLSearchParams): ListRunsOpts {
	const opts: ListRunsOpts = {};
	const status = params.get('status');
	if (status === 'active' || status === 'completed' || status === 'errored') opts.status = status;
	const workflow = params.get('workflow');
	if (workflow) opts.workflowName = workflow;
	const limit = params.get('limit');
	if (limit !== null) opts.limit = Number.parseInt(limit, 10);
	const cursor = params.get('cursor');
	if (cursor) opts.cursor = cursor;
	return opts;
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(limit, MAX_LIST_LIMIT);
}

function jsonHeaders(): Record<string, string> {
	return { 'content-type': 'application/json' };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: jsonHeaders() });
}
