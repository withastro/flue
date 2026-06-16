import type {
	CreateRunInput,
	EndRunInput,
	ListRunsOpts,
	ListRunsResponse,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
} from '@flue/runtime/adapter';
import {
	clampLimit,
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	encodeRunCursor,
	MAX_LIST_LIMIT,
} from '@flue/runtime/adapter';
import type { MongoDocument, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

export class MongoRunStore implements RunStore {
	private values: ValueStore;
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {
		this.values = new ValueStore(runner, prefix);
	}
	async createRun(input: CreateRunInput): Promise<void> {
		const payload =
			input.payload === undefined
				? undefined
				: await this.values.stage(`run:${input.runId}:payload`, input.payload);
		let committed = false;
		try {
			await this.runner.transaction(async (tx) => {
				if (
					await tx.collection(collectionName(this.prefix, 'runs')).findOne({ runId: input.runId })
				)
					return;
				if (payload) await this.values.publish(payload, tx);
				await tx
					.collection(collectionName(this.prefix, 'runs'))
					.insertOne({
						_id: input.runId,
						runId: input.runId,
						workflowName: input.workflowName,
						status: 'active',
						startedAt: new Date(input.startedAt).toISOString(),
						payload: payload ?? null,
					});
				committed = true;
			});
		} catch (error) {
			if (!committed && payload) await this.values.discardStaged(payload);
			throw error;
		}
		if (!committed && payload) await this.values.discardStaged(payload);
	}
	async endRun(input: EndRunInput): Promise<void> {
		const resultPointer =
			input.result === undefined
				? undefined
				: await this.values.stage(`run:${input.runId}:result`, input.result);
		const errorPointer =
			input.error === undefined
				? undefined
				: await this.values.stage(`run:${input.runId}:error`, input.error);
		const staged = [resultPointer, errorPointer].filter((pointer): pointer is StoredValue =>
			Boolean(pointer),
		);
		let committed = false;
		try {
			const previous = await this.runner.transaction(async (tx) => {
				const runs = tx.collection(collectionName(this.prefix, 'runs'));
				const old = await runs.findOne({ runId: input.runId });
				if (!old) return null;
				for (const pointer of staged) await this.values.publish(pointer, tx);
				await runs.updateOne(
					{ runId: input.runId },
					{
						$set: {
							status: input.isError ? 'errored' : 'completed',
							endedAt: input.endedAt,
							isError: input.isError,
							durationMs: input.durationMs,
							result: resultPointer ?? null,
							error: errorPointer ?? null,
						},
					},
				);
				committed = true;
				return old;
			});
			if (!committed) for (const pointer of staged) await this.values.discardStaged(pointer);
			if (previous?.result)
				await this.values.retire(previous.result as unknown as StoredValue).catch(() => undefined);
			if (previous?.error)
				await this.values.retire(previous.error as unknown as StoredValue).catch(() => undefined);
		} catch (error) {
			if (!committed) for (const pointer of staged) await this.values.discardStaged(pointer);
			throw error;
		}
	}
	async getRun(runId: string): Promise<RunRecord | null> {
		const row = await this.c().findOne({ runId });
		return row ? this.record(row) : null;
	}
	async lookupRun(runId: string): Promise<RunPointer | null> {
		const row = await this.c().findOne({ runId });
		return row ? pointer(row) : null;
	}
	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const filter: MongoDocument = {};
		if (opts.status) filter.status = opts.status;
		if (opts.workflowName) filter.workflowName = opts.workflowName;
		if (cursor)
			filter.$or = [
				{ startedAt: { $lt: new Date(cursor.startedAt).toISOString() } },
				{ startedAt: new Date(cursor.startedAt).toISOString(), runId: { $lt: cursor.runId } },
			];
		const rows = await this.c().find(filter, {
			sort: { startedAt: -1, runId: -1 },
			limit: limit + 1,
			collation: { locale: 'simple' },
		});
		const hasNext = rows.length > limit;
		const runs = rows.slice(0, limit).map(pointer);
		const last = runs.at(-1);
		return { runs, ...(hasNext && last ? { nextCursor: encodeRunCursor(last) } : {}) };
	}
	private c() {
		return this.runner.collection(collectionName(this.prefix, 'runs'));
	}
	private async record(row: MongoDocument): Promise<RunRecord> {
		return {
			...pointer(row),
			...(row.payload
				? { payload: await this.values.read(row.payload as unknown as StoredValue) }
				: {}),
			...(row.result
				? { result: await this.values.read(row.result as unknown as StoredValue) }
				: {}),
			...(row.error ? { error: await this.values.read(row.error as unknown as StoredValue) } : {}),
		};
	}
}
function pointer(row: MongoDocument): RunPointer {
	return {
		runId: String(row.runId),
		workflowName: String(row.workflowName),
		status: row.status as RunStatus,
		startedAt: String(row.startedAt),
		...(row.endedAt ? { endedAt: String(row.endedAt) } : {}),
		...(row.isError !== null && row.isError !== undefined ? { isError: Boolean(row.isError) } : {}),
		...(row.durationMs !== null && row.durationMs !== undefined
			? { durationMs: Number(row.durationMs) }
			: {}),
	};
}
