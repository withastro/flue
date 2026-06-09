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
	getRun(runId: string): Promise<RunRecord | null>;
}

const MAX_EVENT_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();

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
