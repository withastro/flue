import type { FlueEvent } from '../types.ts';

export type RunStatus = 'active' | 'completed' | 'errored';

export interface RunRecord {
	runId: string;
	instanceId: string;
	agentName: string;
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
	instanceId: string;
	agentName: string;
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
	maxEventBytes?: number;
}

export const DEFAULT_MAX_COMPLETED_RUNS = 50;
export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

const TRUNCATABLE_FIELDS = ['result', 'args', 'text', 'content'] as const;
const PREVIEW_CHARS = 1024;
const ENCODER = new TextEncoder();

export function truncateEventForPersistence(
	event: FlueEvent,
	maxBytes = DEFAULT_MAX_EVENT_BYTES,
): FlueEvent {
	const candidate = cloneJson(event) as Record<string, unknown>;
	let serialized = JSON.stringify(candidate);
	if (byteLength(serialized) <= maxBytes) return event;

	const originalSerialized = serialized;
	const originalSize = byteLength(originalSerialized);
	const truncatedFields = new Set<string>();

	while (byteLength(serialized) > maxBytes) {
		let largestField: string | undefined;
		let largestSize = 0;

		for (const field of TRUNCATABLE_FIELDS) {
			if (truncatedFields.has(field) || !(field in candidate)) continue;
			const fieldSerialized = JSON.stringify(candidate[field]);
			const fieldSize = byteLength(fieldSerialized);
			if (fieldSize > largestSize) {
				largestField = field;
				largestSize = fieldSize;
			}
		}

		if (!largestField) break;
		candidate[largestField] = truncateValue(candidate[largestField], largestSize);
		truncatedFields.add(largestField);
		serialized = JSON.stringify(candidate);
	}

	if (byteLength(serialized) <= maxBytes) return candidate as FlueEvent;

	return {
		...pickEventIdentity(candidate),
		truncated: true,
		originalSize,
		preview: originalSerialized.slice(0, PREVIEW_CHARS),
	} as unknown as FlueEvent;
}

function truncateValue(value: unknown, originalSize: number): unknown {
	const serialized = JSON.stringify(value);
	return {
		truncated: true,
		originalSize,
		preview: serialized.slice(0, PREVIEW_CHARS),
	};
}

function pickEventIdentity(event: Record<string, unknown>): Record<string, unknown> {
	const identity: Record<string, unknown> = {};
	for (const key of [
		'type',
		'runId',
		'eventIndex',
		'timestamp',
		'session',
		'parentSession',
		'harness',
		'taskId',
		'toolCallId',
		'operationId',
	]) {
		if (key in event) identity[key] = event[key];
	}
	return identity;
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function byteLength(value: string): number {
	return ENCODER.encode(value).byteLength;
}
