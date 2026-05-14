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

interface InstanceRuns {
	runs: Map<string, RunRecord>;
	events: Map<string, FlueEvent[]>;
}

export class InMemoryRunStore implements RunStore {
	private instances = new Map<string, InstanceRuns>();
	private maxCompletedRuns: number;
	private maxEventBytes: number;

	constructor(options: RunStoreOptions = {}) {
		this.maxCompletedRuns = options.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS;
		this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
	}

	async createRun(input: CreateRunInput): Promise<void> {
		const instance = this.getInstance(input.instanceId);
		instance.runs.set(input.runId, {
			runId: input.runId,
			instanceId: input.instanceId,
			agentName: input.agentName,
			status: 'active',
			startedAt: input.startedAt,
		});
		instance.events.set(input.runId, []);
	}

	async endRun(input: EndRunInput): Promise<void> {
		const existing = await this.getRun(input.runId);
		if (!existing) return;
		const instance = this.getInstance(existing.instanceId);
		instance.runs.set(input.runId, {
			...existing,
			status: input.isError ? 'errored' : 'completed',
			endedAt: input.endedAt,
			isError: input.isError,
			durationMs: input.durationMs,
			result: input.result,
			error: input.error,
		});
		this.pruneCompletedRuns(instance);
	}

	async appendEvent(runId: string, event: FlueEvent): Promise<void> {
		const run = await this.getRun(runId);
		if (!run) return;
		const instance = this.getInstance(run.instanceId);
		const events = instance.events.get(runId) ?? [];
		events.push(truncateEventForPersistence(event, this.maxEventBytes));
		instance.events.set(runId, events);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		const run = await this.getRun(runId);
		if (!run) return [];
		const events = this.getInstance(run.instanceId).events.get(runId) ?? [];
		if (fromIndex === undefined) return [...events];
		return events.filter((event) => typeof event.eventIndex === 'number' && event.eventIndex >= fromIndex);
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		for (const instance of this.instances.values()) {
			const run = instance.runs.get(runId);
			if (run) return run;
		}
		return null;
	}

	private getInstance(instanceId: string): InstanceRuns {
		let instance = this.instances.get(instanceId);
		if (!instance) {
			instance = { runs: new Map(), events: new Map() };
			this.instances.set(instanceId, instance);
		}
		return instance;
	}

	private pruneCompletedRuns(instance: InstanceRuns): void {
		const completed = [...instance.runs.values()]
			.filter((run) => run.status !== 'active')
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		const deleteCount = completed.length - this.maxCompletedRuns;
		if (deleteCount <= 0) return;
		for (const run of completed.slice(0, deleteCount)) {
			instance.runs.delete(run.runId);
			instance.events.delete(run.runId);
		}
	}
}
