/** In-memory `RunStore` for explicitly non-durable (no-database) setups. */

import { clampLimit } from '../adapter-helpers.ts';
import {
	type CreateRunInput,
	type CursorTuple,
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	type EndRunInput,
	encodeRunCursor,
	type ListRunsOpts,
	type ListRunsResponse,
	MAX_LIST_LIMIT,
	type RunPointer,
	type RunRecord,
	type RunStore,
} from '../runtime/run-store.ts';

export class InMemoryRunStore implements RunStore {
	private runs = new Map<string, RunRecord>();

	async createRun(input: CreateRunInput): Promise<void> {
		// Idempotent first-writer-wins: never clobber an existing record.
		if (this.runs.has(input.runId)) return;
		this.runs.set(input.runId, {
			runId: input.runId,
			workflowName: input.workflowName,
			status: 'active',
			startedAt: input.startedAt,
			payload: input.payload,
		});
	}

	async endRun(input: EndRunInput): Promise<void> {
		const existing = await this.getRun(input.runId);
		if (!existing) return;
		this.runs.set(input.runId, {
			...existing,
			status: input.isError ? 'errored' : 'completed',
			endedAt: input.endedAt,
			isError: input.isError,
			durationMs: input.durationMs,
			result: input.result,
			error: input.error,
		});
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		return this.runs.get(runId) ?? null;
	}

	async lookupRun(runId: string): Promise<RunPointer | null> {
		const record = this.runs.get(runId);
		return record ? recordToPointer(record) : null;
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const all = [...this.runs.values()]
			.filter((record) => matchesListFilter(record, opts))
			.sort(compareRecordsDesc)
			.map(recordToPointer);
		const startIndex = cursor ? all.findIndex((pointer) => isAfterCursor(pointer, cursor)) : 0;
		if (startIndex === -1) return { runs: [] };
		const page = all.slice(startIndex, startIndex + limit);
		const last = page.at(-1);
		const nextCursor = startIndex + limit < all.length && last ? encodeRunCursor(last) : undefined;
		return { runs: page, nextCursor };
	}
}

function recordToPointer(record: RunRecord): RunPointer {
	return {
		runId: record.runId,
		workflowName: record.workflowName,
		status: record.status,
		startedAt: record.startedAt,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
		...(record.isError !== undefined ? { isError: record.isError } : {}),
	};
}

function matchesListFilter(record: RunRecord, opts: ListRunsOpts): boolean {
	if (opts.status && record.status !== opts.status) return false;
	if (opts.workflowName && record.workflowName !== opts.workflowName) return false;
	return true;
}

function compareRecordsDesc(a: RunRecord, b: RunRecord): number {
	const byStarted = b.startedAt.localeCompare(a.startedAt);
	if (byStarted !== 0) return byStarted;
	return b.runId.localeCompare(a.runId);
}

function isAfterCursor(pointer: RunPointer, cursor: CursorTuple): boolean {
	if (pointer.startedAt < cursor.startedAt) return true;
	if (pointer.startedAt > cursor.startedAt) return false;
	return pointer.runId < cursor.runId;
}
