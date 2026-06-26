import type { FlueTraceCarrier } from '../execution-interceptor.ts';
import type { FlueEvent } from '../types.ts';

export type RunStatus = 'active' | 'completed' | 'errored';

export interface RunRecord {
	runId: string;
	workflowName: string;
	status: RunStatus;
	startedAt: string;
	input?: unknown;
	traceCarrier?: FlueTraceCarrier;
	endedAt?: string;
	isError?: boolean;
	durationMs?: number;
	result?: unknown;
	error?: unknown;
}

/**
 * Listing/lookup projection of a {@link RunRecord}: every field except the
 * potentially large `input`, `result`, and `error` values. Single-database
 * adapters back pointers with a column-subset select over the run records.
 */
export interface WorkflowRunPointer {
	runId: string;
	workflowName: string;
}

export interface RunPointer extends WorkflowRunPointer {
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	isError?: boolean;
}

export interface CreateRunInput {
	runId: string;
	workflowName: string;
	startedAt: string;
	input: unknown;
	traceCarrier?: FlueTraceCarrier;
}

export interface EndRunInput {
	runId: string;
	endedAt: string;
	isError: boolean;
	durationMs: number;
	result?: unknown;
	error?: unknown;
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
	} catch {}
	return undefined;
}

function base64UrlEncode(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const b64 = btoa(binary);
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
	const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
	const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(b64);
	return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * Workflow-run persistence: one record per run, plus pointer lookup and
 * cursor-paginated listing over the same records.
 */
export interface RunStore {
	/**
	 * Persist a new `active` run record.
	 *
	 * Idempotent, first-writer-wins: when a record with the same `runId`
	 * already exists, the call is a no-op and the existing record — including
	 * any terminal status, result, or error — is preserved. SQL backends
	 * implement this with `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
	 */
	createRun(input: CreateRunInput): Promise<void>;
	/**
	 * Finalize a run record with its terminal status. A no-op when no record
	 * exists for `runId`.
	 */
	endRun(input: EndRunInput): Promise<void>;
	getRun(runId: string): Promise<RunRecord | null>;
	/** Minimal ownership pointer for authorizing a run route. */
	lookupRun(runId: string): Promise<WorkflowRunPointer | null>;
	/**
	 * List run pointers newest-first (`startedAt` descending, then `runId`
	 * descending), filtered by `status`/`workflowName` and paginated via the
	 * opaque cursor returned in {@link ListRunsResponse.nextCursor}.
	 */
	listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}

/**
 * Per-chunk streaming events that are buffered before persistence.
 * These events are flushed at most once per interval (~3 s) to avoid
 * starting one storage write per streamed chunk during generation.
 */
const BUFFERED_RUN_EVENT_TYPES: ReadonlySet<FlueEvent['type']> = new Set([
	'text_delta',
	'thinking_start',
	'thinking_delta',
	'thinking_end',
]);

export function isBufferedRunEvent(event: FlueEvent): boolean {
	return BUFFERED_RUN_EVENT_TYPES.has(event.type);
}

/**
 * Events excluded from durable streams entirely: never persisted and never
 * served over HTTP, on agent streams and run streams alike. In-process
 * delivery is unaffected — `observe()` subscribers and exporters such as
 * `@flue/opentelemetry` receive these events with full fidelity.
 *
 * `turn_request` re-serializes the full system prompt, the entire message
 * history, and all tool schemas on every model turn; persisting it grows
 * stream storage quadratically with conversation length and exposes full
 * prompts to every stream reader. Production prompt forensics belongs to an
 * exporter-side content-export opt-in, not the primary database.
 */
const STREAM_EXCLUDED_EVENT_TYPES: ReadonlySet<FlueEvent['type']> = new Set(['turn_request']);

export function isStreamExcludedEvent(event: FlueEvent): boolean {
	return STREAM_EXCLUDED_EVENT_TYPES.has(event.type);
}
