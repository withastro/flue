/** Cross-deployment pointer index over Flue runs. */
import type { RunStatus } from './run-store.ts';

export interface RunPointer {
	runId: string;
	agentName: string;
	instanceId: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface RecordRunStartInput {
	runId: string;
	agentName: string;
	instanceId: string;
	startedAt: string;
}

export interface RecordRunEndInput {
	runId: string;
	endedAt: string;
	durationMs: number;
	isError: boolean;
}

export interface ListRunsOpts {
	status?: RunStatus;
	agentName?: string;
	instanceId?: string;
	limit?: number;
	cursor?: string;
}

export interface ListRunsResponse {
	runs: RunPointer[];
	nextCursor?: string;
}

export interface ListInstancesOpts {
	agentName?: string;
	limit?: number;
	cursor?: string;
}

export interface InstancePointer {
	agentName: string;
	instanceId: string;
}

export interface ListInstancesResponse {
	instances: InstancePointer[];
	nextCursor?: string;
}

/** Defaults for {@link ListRunsOpts.limit} / {@link ListInstancesOpts.limit}. */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

// ─── Cursor codec ──────────────────────────────────────────────────────────

export interface CursorTuple {
	startedAt: string;
	runId: string;
}

export function encodeRunCursor(pointer: { startedAt: string; runId: string }): string {
	return base64UrlEncode(JSON.stringify({ s: pointer.startedAt, r: pointer.runId }));
}

export function decodeRunCursor(cursor: string | undefined): CursorTuple | undefined {
	if (!cursor) return undefined;
	try {
		const decoded = JSON.parse(base64UrlDecode(cursor));
		if (typeof decoded?.s === 'string' && typeof decoded?.r === 'string') {
			return { startedAt: decoded.s, runId: decoded.r };
		}
	} catch {
	}
	return undefined;
}

export function encodeInstanceCursor(key: string): string {
	return base64UrlEncode(key);
}

export function decodeInstanceCursor(cursor: string): string | undefined {
	let decoded: string;
	try {
		decoded = base64UrlDecode(cursor);
	} catch {
		return undefined;
	}
	if (!decoded.includes('\0')) return undefined;
	return decoded;
}

function base64UrlEncode(value: string): string {
	const b64 = btoa(value);
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
	const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
	const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
	return atob(b64);
}

export interface RunRegistry {
	recordRunStart(input: RecordRunStartInput): Promise<void>;
	recordRunEnd(input: RecordRunEndInput): Promise<void>;
	lookupRun(runId: string): Promise<RunPointer | null>;
	listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
	listInstances(opts?: ListInstancesOpts): Promise<ListInstancesResponse>;
}
