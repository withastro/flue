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

/**
 * Per-chunk streaming events are published to live subscribers but never
 * persisted to the run-event journal. Durable recovery of interrupted streams
 * is handled by the throttled StreamChunkWriter segments, and persisted
 * `message_end` events carry the complete message for history replay, so
 * journaling every delta would issue one storage write per streamed chunk.
 */
const EPHEMERAL_RUN_EVENT_TYPES: ReadonlySet<FlueEvent['type']> = new Set([
	'message_update',
	'text_delta',
	'thinking_start',
	'thinking_delta',
	'thinking_end',
]);

export function isEphemeralRunEvent(event: FlueEvent): boolean {
	return EPHEMERAL_RUN_EVENT_TYPES.has(event.type);
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
