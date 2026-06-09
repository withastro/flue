import { RunEventTooLargeError } from '../errors.ts';
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
	appendEvent(runId: string, event: FlueEvent): Promise<void>;
	getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]>;
	getRun(runId: string): Promise<RunRecord | null>;
}

const MAX_EVENT_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();

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

export function serializedEventForPersistence(runId: string, event: FlueEvent): string {
	assertPersistedWorkflowEvent(runId, event);
	const payload = JSON.stringify(event);
	if (byteLength(payload) > MAX_EVENT_BYTES) {
		throw new RunEventTooLargeError();
	}
	return payload;
}

export function parsePersistedWorkflowEvent(
	runId: string,
	payload: string,
	storedEventIndex: number,
): FlueEvent {
	const event = JSON.parse(payload) as FlueEvent;
	const eventIndex = assertPersistedWorkflowEvent(runId, event);
	if (eventIndex !== storedEventIndex) {
		throw new Error('[flue:run-store] persisted workflow event index does not match storage.');
	}
	return event;
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

function byteLength(value: string): number {
	return ENCODER.encode(value).byteLength;
}
