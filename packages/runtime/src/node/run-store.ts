import {
	type CreateRunInput,
	DEFAULT_MAX_COMPLETED_RUNS,
	type EndRunInput,
	type RunRecord,
	type RunStore,
	type RunStoreOptions,
} from '../runtime/run-store.ts';
import type { FlueEvent } from '../types.ts';

interface InstanceRuns {
	runs: Map<string, RunRecord>;
	events: Map<string, FlueEvent[]>;
}

export class InMemoryRunStore implements RunStore {
	private instances = new Map<string, InstanceRuns>();
	private maxCompletedRuns: number;

	constructor(options: RunStoreOptions = {}) {
		this.maxCompletedRuns = options.maxCompletedRuns ?? DEFAULT_MAX_COMPLETED_RUNS;
	}

	async createRun(input: CreateRunInput): Promise<void> {
		if (input.owner.kind === 'workflow' && input.owner.runId !== input.runId) {
			throw new Error('[flue] Workflow run owners must use the same runId as the run record.');
		}
		const instance = this.getInstance(ownerKey(input.owner));
		instance.runs.set(input.runId, {
			runId: input.runId,
			owner: input.owner,
			...(input.owner.kind === 'agent'
				? { agentName: input.owner.agentName, instanceId: input.owner.instanceId }
				: {}),
			status: 'active',
			startedAt: input.startedAt,
		});
		instance.events.set(input.runId, []);
	}

	async endRun(input: EndRunInput): Promise<void> {
		const existing = await this.getRun(input.runId);
		if (!existing) return;
		const instance = this.getInstance(ownerKey(existing.owner));
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
		const instance = this.getInstance(ownerKey(run.owner));
		const events = instance.events.get(runId) ?? [];
		events.push(event);
		instance.events.set(runId, events);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		const run = await this.getRun(runId);
		if (!run) return [];
		const events = this.getInstance(ownerKey(run.owner)).events.get(runId) ?? [];
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

	private getInstance(key: string): InstanceRuns {
		let instance = this.instances.get(key);
		if (!instance) {
			instance = { runs: new Map(), events: new Map() };
			this.instances.set(key, instance);
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

function ownerKey(owner: CreateRunInput['owner']): string {
	return owner.kind === 'agent'
		? `agent\0${owner.agentName}\0${owner.instanceId}`
		: `workflow\0${owner.workflowName}\0${owner.runId}`;
}
