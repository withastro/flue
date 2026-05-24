/** In-memory `RunRegistry` for workflow runs on the Node target. */
import {
	type CursorTuple,
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	encodeRunCursor,
	type ListRunsOpts,
	type ListRunsResponse,
	MAX_LIST_LIMIT,
	type RecordRunEndInput,
	type RecordRunStartInput,
	type RunPointer,
	type RunRegistry,
} from '../runtime/run-registry.ts';

export class InMemoryRunRegistry implements RunRegistry {
	private pointers = new Map<string, RunPointer>();

	async recordRunStart(input: RecordRunStartInput): Promise<void> {
		if (this.pointers.has(input.runId)) return;
		if (input.owner.instanceId !== input.runId) {
			throw new Error('[flue] Workflow run owners must use the same instanceId as the pointer runId.');
		}
		this.pointers.set(input.runId, {
			runId: input.runId,
			owner: input.owner,
			status: 'active',
			startedAt: input.startedAt,
		});
	}

	async recordRunEnd(input: RecordRunEndInput): Promise<void> {
		const pointer = this.pointers.get(input.runId);
		if (!pointer) return;
		this.pointers.set(input.runId, {
			...pointer,
			status: input.isError ? 'errored' : 'completed',
			endedAt: input.endedAt,
			durationMs: input.durationMs,
			isError: input.isError,
		});
	}

	async lookupRun(runId: string): Promise<RunPointer | null> {
		return this.pointers.get(runId) ?? null;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit);
		const cursor = decodeRunCursor(opts.cursor);
		const all = [...this.pointers.values()]
			.filter((pointer) => matchesListFilter(pointer, opts))
			.sort(comparePointersDesc);
		const startIndex = cursor ? all.findIndex((pointer) => isAfterCursor(pointer, cursor)) : 0;
		if (startIndex === -1) return { runs: [] };
		const page = all.slice(startIndex, startIndex + limit);
		const last = page.at(-1);
		const nextCursor = startIndex + limit < all.length && last ? encodeRunCursor(last) : undefined;
		return { runs: page, nextCursor };
	}
}

function matchesListFilter(pointer: RunPointer, opts: ListRunsOpts): boolean {
	if (opts.status && pointer.status !== opts.status) return false;
	if (opts.workflowName && pointer.owner.workflowName !== opts.workflowName) return false;
	return true;
}

function comparePointersDesc(a: RunPointer, b: RunPointer): number {
	const byStarted = b.startedAt.localeCompare(a.startedAt);
	if (byStarted !== 0) return byStarted;
	return b.runId.localeCompare(a.runId);
}

function isAfterCursor(pointer: RunPointer, cursor: CursorTuple): boolean {
	if (pointer.startedAt < cursor.startedAt) return true;
	if (pointer.startedAt > cursor.startedAt) return false;
	return pointer.runId < cursor.runId;
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
	return Math.min(limit, MAX_LIST_LIMIT);
}
