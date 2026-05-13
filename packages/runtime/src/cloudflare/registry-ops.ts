/**
 * Pure SQL-backed registry operations and the REST router that sits in
 * front of them.
 *
 * Lives in its own file (separate from `./registry-do.ts`) so the SQL
 * logic can be unit-tested in Node with a fake `SqlStorage`. The DO
 * class itself imports `cloudflare:workers`, which Node can't resolve
 * — keeping the testable surface out of that import path is what makes
 * the test harness possible without spinning up workerd.
 *
 * Wire shape (private to the registry client / DO pair):
 *
 *   GET    /pointers/<runId>                     → RunPointer | 404
 *   POST   /pointers/<runId>/start  { ... }      → 204
 *   POST   /pointers/<runId>/end    { ... }      → 204
 *   GET    /pointers?status=&agent=&instance=&limit=&cursor=
 *                                                → ListRunsResponse
 *   GET    /instances?agent=&limit=&cursor=     → ListInstancesResponse
 */
import {
	decodeInstanceCursor,
	decodeRunCursor,
	DEFAULT_LIST_LIMIT,
	encodeInstanceCursor,
	encodeRunCursor,
	type InstancePointer,
	type ListInstancesOpts,
	type ListInstancesResponse,
	type ListRunsOpts,
	type ListRunsResponse,
	MAX_LIST_LIMIT,
	type RecordRunEndInput,
	type RecordRunStartInput,
	type RunPointer,
} from '../runtime/run-registry.ts';
import type { RunStatus } from '../runtime/run-store.ts';

/**
 * Per-agent retention cap on completed pointers. Matches
 * `InMemoryRunRegistry`'s `DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT` for
 * behavioral consistency between targets — see phase 1, Q5. Duplicated
 * (small enough that "share one constant module" would itself be the
 * weirder pattern) rather than imported, because `../node/run-registry.ts`
 * has a Node-only orientation we don't want to drag into the CF chunk.
 */
export const DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT = 50;

/**
 * Minimal `SqlStorage` shape. Mirrors the one in `../cloudflare/run-store.ts`.
 * Typed loosely so the file can be compiled with `@cloudflare/workers-types`
 * present OR absent — the real type only matters inside workerd.
 */
export interface SqlResult {
	toArray(): SqlRow[];
}
export type SqlRow = Record<string, unknown>;
export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface RegistryOps {
	recordRunStart(input: RecordRunStartInput): void;
	recordRunEnd(input: RecordRunEndInput): void;
	lookupRun(runId: string): RunPointer | null;
	listRuns(opts: ListRunsOpts): ListRunsResponse;
	listInstances(opts: ListInstancesOpts): ListInstancesResponse;
}

export interface CreateRegistryOpsOptions {
	maxCompletedRunsPerAgent?: number;
}

export function createRegistryOps(
	sql: SqlStorage,
	options: CreateRegistryOpsOptions = {},
): RegistryOps {
	ensureRegistryTables(sql);
	return new SqlRegistryOps(
		sql,
		options.maxCompletedRunsPerAgent ?? DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT,
	);
}

/**
 * Dispatch a registry HTTP request against a `RegistryOps`. Shared
 * between the workerd-loaded `FlueRegistry` DO and the unit test
 * harness.
 */
export async function handleRegistryRequest(
	ops: RegistryOps,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const segments = url.pathname.split('/').filter(Boolean);

	try {
		// GET /pointers/<runId>
		if (request.method === 'GET' && segments[0] === 'pointers' && segments.length === 2) {
			const runId = segments[1]!;
			const pointer = ops.lookupRun(runId);
			// Empty 404 body (not `"null"`): the client detects miss via
			// `response.status === 404` and does not try to parse JSON.
			// Saves a parser invocation on the hot lookup path.
			if (!pointer) return new Response(null, { status: 404 });
			return jsonResponse(pointer);
		}

		// POST /pointers/<runId>/start
		if (
			request.method === 'POST' &&
			segments[0] === 'pointers' &&
			segments[2] === 'start' &&
			segments.length === 3
		) {
			const runId = segments[1]!;
			const body = (await request.json()) as RecordRunStartInput;
			ops.recordRunStart({ ...body, runId });
			return new Response(null, { status: 204 });
		}

		// POST /pointers/<runId>/end
		if (
			request.method === 'POST' &&
			segments[0] === 'pointers' &&
			segments[2] === 'end' &&
			segments.length === 3
		) {
			const runId = segments[1]!;
			const body = (await request.json()) as Omit<RecordRunEndInput, 'runId'>;
			ops.recordRunEnd({ ...body, runId });
			return new Response(null, { status: 204 });
		}

		// GET /pointers?...
		if (request.method === 'GET' && segments[0] === 'pointers' && segments.length === 1) {
			const opts = parseListRunsOpts(url.searchParams);
			return jsonResponse(ops.listRuns(opts));
		}

		// GET /instances?...
		if (request.method === 'GET' && segments[0] === 'instances' && segments.length === 1) {
			const opts = parseListInstancesOpts(url.searchParams);
			return jsonResponse(ops.listInstances(opts));
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

// ─── SQL ops impl ──────────────────────────────────────────────────────────

class SqlRegistryOps implements RegistryOps {
	private sql: SqlStorage;
	private maxCompletedRunsPerAgent: number;

	constructor(sql: SqlStorage, maxCompletedRunsPerAgent: number) {
		this.sql = sql;
		this.maxCompletedRunsPerAgent = maxCompletedRunsPerAgent;
	}

	recordRunStart(input: RecordRunStartInput): void {
		// `OR IGNORE` (not `OR REPLACE`): idempotent on existing runId so
		// a re-start in the runtime-degraded "registry restart with an
		// in-flight run" case never clobbers a row that already
		// terminated. Run ids are server-minted ULIDs, so real collision
		// is statistically zero — this is purely about not creating data
		// loss when the lifecycle re-fires.
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_registry_runs
			 (run_id, agent_name, instance_id, status, started_at, ended_at, duration_ms, is_error)
			 VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL)`,
			input.runId,
			input.agentName,
			input.instanceId,
			input.startedAt,
		);
	}

	recordRunEnd(input: RecordRunEndInput): void {
		// Look up the pointer's agent so we can prune that agent's bucket
		// after the update. If the pointer doesn't exist (shouldn't happen
		// in normal lifecycle — recordRunEnd always follows recordRunStart),
		// silently drop the update. Same posture as `InMemoryRunRegistry`.
		const existing = this.sql
			.exec('SELECT agent_name FROM flue_registry_runs WHERE run_id = ?', input.runId)
			.toArray();
		if (existing.length === 0) return;

		this.sql.exec(
			`UPDATE flue_registry_runs
			 SET status = ?, ended_at = ?, duration_ms = ?, is_error = ?
			 WHERE run_id = ?`,
			input.isError ? 'errored' : 'completed',
			input.endedAt,
			input.durationMs,
			input.isError ? 1 : 0,
			input.runId,
		);

		const agentName = String(existing[0]!.agent_name);
		this.pruneCompletedRunsForAgent(agentName);
	}

	lookupRun(runId: string): RunPointer | null {
		const rows = this.sql
			.exec('SELECT * FROM flue_registry_runs WHERE run_id = ?', runId)
			.toArray();
		const row = rows[0];
		if (!row) return null;
		return rowToRunPointer(row);
	}

	listRuns(opts: ListRunsOpts): ListRunsResponse {
		const limit = clampLimit(opts.limit);
		const cursor = decodeRunCursor(opts.cursor);

		// Build a parameterized WHERE clause incrementally so we never
		// interpolate user-supplied values into SQL text. Filters compose:
		// status ∧ agent ∧ instance ∧ cursor.
		const wheres: string[] = [];
		const bindings: unknown[] = [];
		if (opts.status) {
			wheres.push('status = ?');
			bindings.push(opts.status);
		}
		if (opts.agentName) {
			wheres.push('agent_name = ?');
			bindings.push(opts.agentName);
		}
		if (opts.instanceId) {
			wheres.push('instance_id = ?');
			bindings.push(opts.instanceId);
		}
		// Keyset pagination: "after" the cursor in the descending sort
		// order is `(started_at < cursor.startedAt) OR (started_at = cursor.startedAt AND run_id < cursor.runId)`.
		if (cursor) {
			wheres.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
			bindings.push(cursor.startedAt, cursor.startedAt, cursor.runId);
		}

		const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
		// Fetch `limit + 1` so we can tell whether there's another page
		// without a separate COUNT.
		const rows = this.sql
			.exec(
				`SELECT * FROM flue_registry_runs ${whereClause}
				 ORDER BY started_at DESC, run_id DESC
				 LIMIT ?`,
				...bindings,
				limit + 1,
			)
			.toArray();

		const hasMore = rows.length > limit;
		const page = (hasMore ? rows.slice(0, limit) : rows).map(rowToRunPointer);
		const nextCursor =
			hasMore && page.length > 0 ? encodeRunCursor(page[page.length - 1]!) : undefined;
		return { runs: page, nextCursor };
	}

	listInstances(opts: ListInstancesOpts): ListInstancesResponse {
		const limit = clampLimit(opts.limit);
		const cursorKey = opts.cursor ? decodeInstanceCursor(opts.cursor) : undefined;

		const wheres: string[] = [];
		const bindings: unknown[] = [];
		if (opts.agentName) {
			wheres.push('agent_name = ?');
			bindings.push(opts.agentName);
		}
		// Cursor is the literal `agent\0instance` key used as a string
		// comparator; pagination is "strictly greater than" in lex order.
		if (cursorKey !== undefined) {
			// We compare the composed `(agent_name, instance_id)` tuple by
			// emulating string concat with a NUL byte. SQLite's `||` does
			// the same conversion as the in-memory `instanceKey` helper.
			wheres.push(`(agent_name || x'00' || instance_id) > ?`);
			bindings.push(cursorKey);
		}
		const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';

		const rows = this.sql
			.exec(
				`SELECT DISTINCT agent_name, instance_id FROM flue_registry_runs ${whereClause}
				 ORDER BY agent_name ASC, instance_id ASC
				 LIMIT ?`,
				...bindings,
				limit + 1,
			)
			.toArray();

		const hasMore = rows.length > limit;
		const page: InstancePointer[] = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
			agentName: String(row.agent_name),
			instanceId: String(row.instance_id),
		}));
		const nextCursor =
			hasMore && page.length > 0
				? encodeInstanceCursor(
						`${page[page.length - 1]!.agentName}\0${page[page.length - 1]!.instanceId}`,
					)
				: undefined;
		return { instances: page, nextCursor };
	}

	private pruneCompletedRunsForAgent(agentName: string): void {
		// One statement: keep the most recent N completed-or-errored
		// pointers per agent, delete the rest. Active runs are never
		// matched by the outer WHERE so they're untouched.
		this.sql.exec(
			`DELETE FROM flue_registry_runs
			 WHERE agent_name = ?
			   AND status != 'active'
			   AND run_id NOT IN (
			     SELECT run_id FROM flue_registry_runs
			     WHERE agent_name = ? AND status != 'active'
			     ORDER BY started_at DESC, run_id DESC
			     LIMIT ?
			   )`,
			agentName,
			agentName,
			this.maxCompletedRunsPerAgent,
		);
	}
}

// ─── SQL schema ────────────────────────────────────────────────────────────

function ensureRegistryTables(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_registry_runs (
		 run_id TEXT PRIMARY KEY,
		 agent_name TEXT NOT NULL,
		 instance_id TEXT NOT NULL,
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
		'CREATE INDEX IF NOT EXISTS flue_registry_agent_instance_idx ON flue_registry_runs (agent_name, instance_id)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_registry_agent_started_idx ON flue_registry_runs (agent_name, started_at DESC)',
	);
}

// ─── Row → pointer ─────────────────────────────────────────────────────────

function rowToRunPointer(row: SqlRow): RunPointer {
	return {
		runId: String(row.run_id),
		agentName: String(row.agent_name),
		instanceId: String(row.instance_id),
		status: String(row.status) as RunStatus,
		startedAt: String(row.started_at),
		endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
		isError:
			row.is_error === null || row.is_error === undefined ? undefined : Boolean(row.is_error),
	};
}

// ─── Query string parsing ──────────────────────────────────────────────────

function parseListRunsOpts(params: URLSearchParams): ListRunsOpts {
	const opts: ListRunsOpts = {};
	const status = params.get('status');
	if (status === 'active' || status === 'completed' || status === 'errored') {
		opts.status = status;
	}
	const agent = params.get('agent');
	if (agent) opts.agentName = agent;
	const instance = params.get('instance');
	if (instance) opts.instanceId = instance;
	const limit = params.get('limit');
	if (limit !== null) opts.limit = Number.parseInt(limit, 10);
	const cursor = params.get('cursor');
	if (cursor) opts.cursor = cursor;
	return opts;
}

function parseListInstancesOpts(params: URLSearchParams): ListInstancesOpts {
	const opts: ListInstancesOpts = {};
	const agent = params.get('agent');
	if (agent) opts.agentName = agent;
	const limit = params.get('limit');
	if (limit !== null) opts.limit = Number.parseInt(limit, 10);
	const cursor = params.get('cursor');
	if (cursor) opts.cursor = cursor;
	return opts;
}

// ─── Misc helpers ──────────────────────────────────────────────────────────

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
