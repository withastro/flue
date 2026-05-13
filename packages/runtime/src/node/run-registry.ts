/**
 * In-memory `RunRegistry` for the Node target.
 *
 * One module-scoped instance is created by the generated server entry
 * and lives in the runtime config alongside the existing
 * `InMemoryRunStore`. Restart drops state — same lifetime as the store.
 *
 * Pruning policy mirrors the store's "bounded retention" pattern: after
 * every `recordRunEnd`, completed pointers are pruned per instance down to
 * {@link DEFAULT_MAX_COMPLETED_RUNS_PER_INSTANCE}. Active runs are never
 * pruned.
 */
import {
	type CursorTuple,
	DEFAULT_LIST_LIMIT,
	decodeInstanceCursor,
	decodeRunCursor,
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
	type RunRegistry,
} from '../runtime/run-registry.ts';

export interface InMemoryRunRegistryOptions {
	/**
	 * Per-instance cap on retained completed pointers. Defaults to 50,
	 * mirroring `InMemoryRunStore`'s per-instance run cap. Active runs
	 * are never pruned.
	 */
	maxCompletedRunsPerInstance?: number;
}

export const DEFAULT_MAX_COMPLETED_RUNS_PER_INSTANCE = 50;

export class InMemoryRunRegistry implements RunRegistry {
	private pointers = new Map<string, RunPointer>();
	private byInstance = new Map<string, Set<string>>();
	private instances = new Set<string>();
	private maxCompletedRunsPerInstance: number;

	constructor(options: InMemoryRunRegistryOptions = {}) {
		this.maxCompletedRunsPerInstance =
			options.maxCompletedRunsPerInstance ?? DEFAULT_MAX_COMPLETED_RUNS_PER_INSTANCE;
	}

	async recordRunStart(input: RecordRunStartInput): Promise<void> {
		// Idempotent on existing runId. Run ids are server-minted ULIDs
		// so a real collision is statistically zero, but the
		// runtime-degraded "registry restart with an in-flight run"
		// case (where this could fire twice for one run) must not
		// clobber a row that already terminated.
		if (this.pointers.has(input.runId)) return;

		const pointer: RunPointer = {
			runId: input.runId,
			agentName: input.agentName,
			instanceId: input.instanceId,
			status: 'active',
			startedAt: input.startedAt,
		};
		this.pointers.set(input.runId, pointer);

		const key = instanceKey(input.agentName, input.instanceId);
		let instanceBucket = this.byInstance.get(key);
		if (!instanceBucket) {
			instanceBucket = new Set();
			this.byInstance.set(key, instanceBucket);
		}
		instanceBucket.add(input.runId);

		this.instances.add(key);
	}

	async recordRunEnd(input: RecordRunEndInput): Promise<void> {
		const pointer = this.pointers.get(input.runId);
		// recordRunEnd before recordRunStart should never happen in the
		// lifecycle — but if it does (e.g. registry restart mid-run),
		// drop the update rather than fabricating a pointer. The owning
		// store remains the source of truth for run records.
		if (!pointer) return;
		this.pointers.set(input.runId, {
			...pointer,
			status: input.isError ? 'errored' : 'completed',
			endedAt: input.endedAt,
			durationMs: input.durationMs,
			isError: input.isError,
		});
		this.pruneCompletedRunsForInstance(pointer.agentName, pointer.instanceId);
	}

	async lookupRun(runId: string): Promise<RunPointer | null> {
		return this.pointers.get(runId) ?? null;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit);
		const cursor = decodeRunCursor(opts.cursor);

		// Snapshot once so subsequent writes during pagination don't
		// shift the result order. The data set is small (bounded by
		// maxCompletedRunsPerInstance * instanceCount + active runs); a full
		// sorted scan per call is fine for v1.
		const all = [...this.pointers.values()]
			.filter((p) => matchesListFilter(p, opts))
			.sort(comparePointersDesc);

		const startIndex = cursor ? all.findIndex((p) => isAfterCursor(p, cursor)) : 0;
		if (startIndex === -1) {
			return { runs: [] };
		}

		const page = all.slice(startIndex, startIndex + limit);
		const last = page.at(-1);
		const nextCursor = startIndex + limit < all.length && last ? encodeRunCursor(last) : undefined;
		return { runs: page, nextCursor };
	}

	async listInstances(opts: ListInstancesOpts = {}): Promise<ListInstancesResponse> {
		const limit = clampLimit(opts.limit);

		const all: InstancePointer[] = [...this.instances]
			.map(parseInstanceKey)
			.filter((i) => !opts.agentName || i.agentName === opts.agentName)
			.sort((a, b) => {
				const byAgent = a.agentName.localeCompare(b.agentName);
				return byAgent !== 0 ? byAgent : a.instanceId.localeCompare(b.instanceId);
			});

		// Cursor here is an opaque (agentName, instanceId) tuple to mirror
		// the shape of the runs cursor. Decoded back into a string compare.
		const cursorKey = opts.cursor ? decodeInstanceCursor(opts.cursor) : undefined;
		const startIndex = cursorKey
			? all.findIndex((i) => instanceKey(i.agentName, i.instanceId) > cursorKey)
			: 0;
		if (startIndex === -1) return { instances: [] };

		const page = all.slice(startIndex, startIndex + limit);
		const last = page.at(-1);
		const nextCursor =
			startIndex + limit < all.length && last
				? encodeInstanceCursor(instanceKey(last.agentName, last.instanceId))
				: undefined;
		return { instances: page, nextCursor };
	}

	private pruneCompletedRunsForInstance(agentName: string, instanceId: string): void {
		const key = instanceKey(agentName, instanceId);
		const bucket = this.byInstance.get(key);
		if (!bucket) return;

		const completed = [...bucket]
			.map((id) => this.pointers.get(id))
			.filter((p): p is RunPointer => p !== undefined && p.status !== 'active')
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

		const deleteCount = completed.length - this.maxCompletedRunsPerInstance;
		if (deleteCount <= 0) return;

		for (const pointer of completed.slice(0, deleteCount)) {
			this.pointers.delete(pointer.runId);
			bucket.delete(pointer.runId);
		}
		if (bucket.size === 0) {
			this.byInstance.delete(key);
			this.instances.delete(key);
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function instanceKey(agentName: string, instanceId: string): string {
	return `${agentName}\0${instanceId}`;
}

function parseInstanceKey(key: string): InstancePointer {
	const [agentName, instanceId] = key.split('\0');
	return { agentName: agentName ?? '', instanceId: instanceId ?? '' };
}

function matchesListFilter(pointer: RunPointer, opts: ListRunsOpts): boolean {
	if (opts.status && pointer.status !== opts.status) return false;
	if (opts.agentName && pointer.agentName !== opts.agentName) return false;
	if (opts.instanceId && pointer.instanceId !== opts.instanceId) return false;
	return true;
}

/** Descending sort by `startedAt`, then by `runId` to make ties deterministic. */
function comparePointersDesc(a: RunPointer, b: RunPointer): number {
	const byStarted = b.startedAt.localeCompare(a.startedAt);
	if (byStarted !== 0) return byStarted;
	return b.runId.localeCompare(a.runId);
}

function isAfterCursor(pointer: RunPointer, cursor: CursorTuple): boolean {
	// "After" in the descending-sort order means strictly older startedAt,
	// or same startedAt with a strictly smaller runId.
	if (pointer.startedAt < cursor.startedAt) return true;
	if (pointer.startedAt > cursor.startedAt) return false;
	return pointer.runId < cursor.runId;
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(limit, MAX_LIST_LIMIT);
}
