/**
 * In-memory `RunRegistry` for the Node target.
 *
 * One module-scoped instance is created by the generated server entry
 * and lives in the runtime config alongside the existing
 * `InMemoryRunStore`. Restart drops state — same lifetime as the store.
 *
 * Pruning policy mirrors the store's "bounded retention" pattern: after
 * every `recordRunEnd`, completed pointers are pruned per-agent down to
 * {@link DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT}. The bucket is keyed by
 * `agentName` (not `instanceId`) because instance ids can be effectively
 * unique per call in some agent topologies, which would make a
 * per-instance cap behave as no cap at all.
 */
import {
	DEFAULT_LIST_LIMIT,
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
	 * Per-agent cap on retained completed pointers. Defaults to 50,
	 * mirroring `InMemoryRunStore`'s per-instance run cap. Active runs
	 * are never pruned.
	 */
	maxCompletedRunsPerAgent?: number;
}

export const DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT = 50;

export class InMemoryRunRegistry implements RunRegistry {
	private pointers = new Map<string, RunPointer>();
	private byAgent = new Map<string, Set<string>>();
	private instances = new Set<string>();
	private maxCompletedRunsPerAgent: number;

	constructor(options: InMemoryRunRegistryOptions = {}) {
		this.maxCompletedRunsPerAgent =
			options.maxCompletedRunsPerAgent ?? DEFAULT_MAX_COMPLETED_RUNS_PER_AGENT;
	}

	async recordRunStart(input: RecordRunStartInput): Promise<void> {
		const pointer: RunPointer = {
			runId: input.runId,
			agentName: input.agentName,
			instanceId: input.instanceId,
			status: 'active',
			startedAt: input.startedAt,
		};
		this.pointers.set(input.runId, pointer);

		let agentBucket = this.byAgent.get(input.agentName);
		if (!agentBucket) {
			agentBucket = new Set();
			this.byAgent.set(input.agentName, agentBucket);
		}
		agentBucket.add(input.runId);

		this.instances.add(instanceKey(input.agentName, input.instanceId));
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
		this.pruneCompletedRunsForAgent(pointer.agentName);
	}

	async lookupRun(runId: string): Promise<RunPointer | null> {
		return this.pointers.get(runId) ?? null;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit);
		const cursor = decodeCursor(opts.cursor);

		// Snapshot once so subsequent writes during pagination don't
		// shift the result order. The data set is small (bounded by
		// maxCompletedRunsPerAgent * agentCount + active runs); a full
		// sorted scan per call is fine for v1.
		const all = [...this.pointers.values()]
			.filter((p) => matchesListFilter(p, opts))
			.sort(comparePointersDesc);

		const startIndex = cursor ? all.findIndex((p) => isAfterCursor(p, cursor)) : 0;
		if (startIndex === -1) {
			return { runs: [] };
		}

		const page = all.slice(startIndex, startIndex + limit);
		const nextCursor =
			startIndex + limit < all.length && page.length > 0
				? encodeCursor(page[page.length - 1]!)
				: undefined;
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
		const nextCursor =
			startIndex + limit < all.length && page.length > 0
				? encodeInstanceCursor(
						instanceKey(page[page.length - 1]!.agentName, page[page.length - 1]!.instanceId),
					)
				: undefined;
		return { instances: page, nextCursor };
	}

	private pruneCompletedRunsForAgent(agentName: string): void {
		const bucket = this.byAgent.get(agentName);
		if (!bucket) return;

		const completed = [...bucket]
			.map((id) => this.pointers.get(id))
			.filter((p): p is RunPointer => p !== undefined && p.status !== 'active')
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

		const deleteCount = completed.length - this.maxCompletedRunsPerAgent;
		if (deleteCount <= 0) return;

		for (const pointer of completed.slice(0, deleteCount)) {
			this.pointers.delete(pointer.runId);
			bucket.delete(pointer.runId);
		}
		if (bucket.size === 0) this.byAgent.delete(agentName);
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

interface CursorTuple {
	startedAt: string;
	runId: string;
}

function isAfterCursor(pointer: RunPointer, cursor: CursorTuple): boolean {
	// "After" in the descending-sort order means strictly older startedAt,
	// or same startedAt with a strictly smaller runId.
	if (pointer.startedAt < cursor.startedAt) return true;
	if (pointer.startedAt > cursor.startedAt) return false;
	return pointer.runId < cursor.runId;
}

function encodeCursor(pointer: RunPointer): string {
	return base64UrlEncode(JSON.stringify({ s: pointer.startedAt, r: pointer.runId }));
}

function decodeCursor(cursor: string | undefined): CursorTuple | undefined {
	if (!cursor) return undefined;
	try {
		const decoded = JSON.parse(base64UrlDecode(cursor));
		if (typeof decoded?.s === 'string' && typeof decoded?.r === 'string') {
			return { startedAt: decoded.s, runId: decoded.r };
		}
	} catch {
		// Malformed cursor: behave as if no cursor was supplied. The
		// alternative — throwing — would be too brittle for a value
		// that's meant to be opaque round-tripped from a prior response.
	}
	return undefined;
}

function encodeInstanceCursor(key: string): string {
	return base64UrlEncode(key);
}

function decodeInstanceCursor(cursor: string): string | undefined {
	try {
		return base64UrlDecode(cursor);
	} catch {
		return undefined;
	}
}

function base64UrlEncode(value: string): string {
	return Buffer.from(value, 'utf-8').toString('base64url');
}

function base64UrlDecode(value: string): string {
	return Buffer.from(value, 'base64url').toString('utf-8');
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(limit, MAX_LIST_LIMIT);
}
