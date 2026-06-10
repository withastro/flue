import {
	type CreateRunInput,
	type EndRunInput,
	type RunRecord,
	type RunStore,
} from '../runtime/run-store.ts';

export class InMemoryRunStore implements RunStore {
	private runs = new Map<string, RunRecord>();

	async createRun(input: CreateRunInput): Promise<void> {
		if (input.owner.instanceId !== input.runId) {
			throw new Error(
				'[flue] Workflow run owners must use the same instanceId as the run record runId.',
			);
		}
		this.runs.set(input.runId, {
			runId: input.runId,
			owner: input.owner,
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
}
