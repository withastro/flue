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
 * Per-chunk streaming events that are throttle-batched before persistence.
 * These events are delivered to live stream readers but appended to the
 * durable event stream at most once per flush interval (~3 s) to avoid
 * issuing one storage write per streamed chunk.
 *
 * Durability is unaffected: interrupted-stream recovery reads the throttled
 * StreamChunkWriter segments, and `message_end` carries the complete message
 * for history replay.
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
