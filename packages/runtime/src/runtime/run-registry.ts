/** Cross-deployment pointer index over workflow runs. */
import type { RunStatus } from './run-store.ts';

export type RunOwner = { kind: 'workflow'; workflowName: string; instanceId: string };

export interface RecordRunStartInput {
	runId: string;
	owner: RunOwner;
	startedAt: string;
}

export interface RunPointer {
	runId: string;
	owner: RunOwner;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface RecordRunEndInput {
	runId: string;
	endedAt: string;
	durationMs: number;
	isError: boolean;
}

export interface ListRunsOpts {
	status?: RunStatus;
	workflowName?: string;
	limit?: number;
	cursor?: string;
}

export interface ListRunsResponse {
	runs: RunPointer[];
	nextCursor?: string;
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

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
}
