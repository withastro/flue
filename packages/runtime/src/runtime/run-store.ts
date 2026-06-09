import type { FlueEvent } from '../types.ts';

export type RunStatus = 'active' | 'completed' | 'errored';

import type { RunOwner } from './run-registry.ts';

export interface RunRecord {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	payload?: unknown;
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
	getRun(runId: string): Promise<RunRecord | null>;
}

export function assertPersistedWorkflowEvent(runId: string, event: FlueEvent): number {
	if (event.runId !== runId) {
		throw new Error('[flue:run-store] persisted workflow event runId does not match its run.');
	}
	if (!Number.isSafeInteger(event.eventIndex) || (event.eventIndex ?? -1) < 0) {
		throw new Error(
			'[flue:run-store] persisted workflow event index must be a non-negative integer.',
		);
	}
	return event.eventIndex as number;
}
