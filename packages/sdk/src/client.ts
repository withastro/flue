import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';
import { invokeAction, type SyncInvokeResult, type WebhookInvokeResult } from './public/invoke.ts';
import { type StreamOptions, streamRunEvents } from './public/stream.ts';
import type { ActionManifestEntry, FlueEvent, ListResponse, RunPointer, RunRecord, RunStatus, StoredFlueEvent } from './types.ts';

export type { RequestHeaders };

export interface CreateFlueClientOptions extends HttpClientOptions {
	/** Mount path for `admin()`. Defaults to `/admin`. */
	adminBasePath?: string;
}

export interface FlueClient {
	runs: {
		get(runId: string): Promise<RunRecord>;
		events(runId: string, options?: { after?: number; types?: string[]; limit?: number }): Promise<{ events: StoredFlueEvent[] }>;
		stream(runId: string, options?: StreamOptions): AsyncIterable<StoredFlueEvent>;
	};
	actions: {
		invoke(actionName: string, instanceId: string, options: { mode: 'stream'; payload?: unknown; signal?: AbortSignal }): AsyncIterable<FlueEvent>;
		invoke(actionName: string, instanceId: string, options: { mode: 'sync'; payload?: unknown; signal?: AbortSignal }): Promise<SyncInvokeResult>;
		invoke(actionName: string, instanceId: string, options: { mode: 'webhook'; payload?: unknown; signal?: AbortSignal }): Promise<WebhookInvokeResult>;
	};
	admin: {
		actions: { list(): Promise<ListResponse<ActionManifestEntry>> };
		runs: {
			list(options?: ListRunsOptions): Promise<ListResponse<RunPointer>>;
			get(runId: string): Promise<RunRecord>;
		};
	};
}

export interface ListOptions {
	cursor?: string;
	limit?: number;
}

export interface ListRunsOptions extends ListOptions {
	status?: RunStatus;
	actionName?: string;
}

export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	const adminBasePath = normalizeBasePath(options.adminBasePath ?? '/admin');
	return {
		runs: {
			get: (runId) => http.json({ path: `/runs/${encodeURIComponent(runId)}` }),
			events: (runId, opts = {}) =>
				http.json({
					path: `/runs/${encodeURIComponent(runId)}/events`,
					query: { after: opts.after, types: opts.types?.join(','), limit: opts.limit },
				}),
			stream: (runId, opts) => streamRunEvents(http, runId, opts),
		},
		actions: {
			invoke: ((actionName: string, instanceId: string, opts: Parameters<typeof invokeAction>[3]) =>
				invokeAction(http, actionName, instanceId, opts)) as FlueClient['actions']['invoke'],
		},
		admin: {
			actions: {
				list: () => http.json({ path: `${adminBasePath}/actions` }),
			},
			runs: {
				list: (opts = {}) => http.json({ path: `${adminBasePath}/runs`, query: runsQuery(opts) }),
				get: (runId) => http.json({ path: `${adminBasePath}/runs/${encodeURIComponent(runId)}` }),
			},
		},
	};
}

function normalizeBasePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed || trimmed === '/') return '';
	return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function listQuery(opts: ListOptions): Record<string, string | number | undefined> {
	return { cursor: opts.cursor, limit: opts.limit };
}

function runsQuery(opts: ListRunsOptions): Record<string, string | number | undefined> {
	return { ...listQuery(opts), status: opts.status, actionName: opts.actionName };
}
