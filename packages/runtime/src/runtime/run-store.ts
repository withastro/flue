import type { FlueEvent } from '../types.ts';

export type RunStatus = 'active' | 'completed' | 'errored';

import type { RunOwner } from './run-registry.ts';

export interface RunRecord {
	runId: string;
	owner: RunOwner;
	agentName?: string;
	instanceId?: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	isError?: boolean;
	durationMs?: number;
	result?: unknown;
	error?: unknown;
}

export interface CreateRunInput {
	runId: string;
	owner: RunOwner;
	startedAt: string;
	payload: unknown;
}

export interface EndRunInput {
	runId: string;
	endedAt: string;
	isError: boolean;
	durationMs: number;
	result?: unknown;
	error?: unknown;
}

export interface RunStore {
	createRun(input: CreateRunInput): Promise<void>;
	endRun(input: EndRunInput): Promise<void>;
	appendEvent(runId: string, event: FlueEvent): Promise<void>;
	getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]>;
	getRun(runId: string): Promise<RunRecord | null>;
}

export interface RunStoreOptions {
	maxCompletedRuns?: number;
}

export const DEFAULT_MAX_COMPLETED_RUNS = 50;
