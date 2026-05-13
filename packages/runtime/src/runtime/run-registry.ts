/**
 * Cross-cutting pointer index over every run in a Flue deployment.
 *
 * The registry is intentionally narrow: per-run rows carry only enough to
 * answer "which agent + instance owns runId X?" and to power list queries.
 * Full run records (payload, result, event log) stay in the per-instance
 * {@link RunStore}; the registry is the global index that points at them.
 *
 * Two implementations land in Phase 1:
 *   - Node: in-process `InMemoryRunRegistry` (this file's neighbor in
 *     ../node/run-registry.ts).
 *   - Cloudflare: a singleton `FlueRegistry` Durable Object that every
 *     agent DO writes to on run start/end (lands in Commit B).
 *
 * Both implementations expose the same surface so the Phase 3 admin
 * endpoints can route list/lookup queries identically across targets.
 */
import type { RunStatus } from './run-store.ts';

/**
 * Per-run row stored in the registry. Deliberately minimal — enough to
 * route a `/runs/:runId` request and power admin list filters; nothing
 * more.
 *
 * Notably absent: `payload`, `result`, `error`, the event log. Those
 * stay in the owning {@link RunStore}. See the Phase 1 plan, decision 1,
 * for the rationale.
 */
export interface RunPointer {
	runId: string;
	agentName: string;
	instanceId: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface RecordRunStartInput {
	runId: string;
	agentName: string;
	instanceId: string;
	startedAt: string;
}

export interface RecordRunEndInput {
	runId: string;
	endedAt: string;
	durationMs: number;
	isError: boolean;
}

/**
 * Options for {@link RunRegistry.listRuns}.
 *
 * Page size is bounded server-side (default 100, max 1000) to keep
 * pagination predictable; callers that want everything iterate
 * `nextCursor` until it's undefined.
 *
 * `cursor` is opaque — produced by a prior call's `nextCursor`. The
 * shape is implementation-defined (base64-encoded `(startedAt, runId)`
 * tuple today) and consumers must not parse it.
 */
export interface ListRunsOpts {
	status?: RunStatus;
	agentName?: string;
	instanceId?: string;
	limit?: number;
	cursor?: string;
}

export interface ListRunsResponse {
	runs: RunPointer[];
	nextCursor?: string;
}

/**
 * Options for {@link RunRegistry.listInstances}. Returns the distinct
 * `(agentName, instanceId)` pairs that have ever recorded a run.
 *
 * Phase 3 admin endpoints consume this; Phase 1 ships it for interface
 * parity but does not route it over HTTP.
 */
export interface ListInstancesOpts {
	agentName?: string;
	limit?: number;
	cursor?: string;
}

export interface InstancePointer {
	agentName: string;
	instanceId: string;
}

export interface ListInstancesResponse {
	instances: InstancePointer[];
	nextCursor?: string;
}

/** Defaults for {@link ListRunsOpts.limit} / {@link ListInstancesOpts.limit}. */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

/**
 * Cross-deployment run pointer index.
 *
 * Writes are issued from the run lifecycle: `recordRunStart` after
 * `RunStore.createRun`, `recordRunEnd` after `RunStore.endRun`. Both
 * writes are synchronous in the lifecycle path — a registry write
 * failure is logged but does not abort the run (the run will still
 * appear in the owning store; only the registry index will be missing
 * the pointer until self-healing lands in a future phase).
 *
 * Reads are issued from the bare `/runs/:runId` route handlers and (in
 * Phase 3) the admin list endpoints. The registry never serves the run
 * record itself; the route handler does a second hop to the owning
 * `RunStore` after the registry resolves the pointer.
 */
export interface RunRegistry {
	recordRunStart(input: RecordRunStartInput): Promise<void>;
	recordRunEnd(input: RecordRunEndInput): Promise<void>;
	lookupRun(runId: string): Promise<RunPointer | null>;
	listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
	listInstances(opts?: ListInstancesOpts): Promise<ListInstancesResponse>;
}
