import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';
import { invokeAgent, type SyncInvokeResult } from './public/invoke.ts';
import { type StreamOptions, streamRunEvents } from './public/stream.ts';
import {
	connectAgentSocket,
	connectWorkflowSocket,
	defaultWebSocketFactory,
	type AgentSocket,
	type WebSocketFactory,
	webSocketUrl,
	type WorkflowSocket,
} from './public/websocket.ts';
import type { AgentManifestEntry, ListResponse, RunPointer, RunRecord, RunStatus } from './types.ts';

export type { RequestHeaders };

export interface CreateFlueClientOptions extends HttpClientOptions {
	/** Mount path for `admin()`. Defaults to `/admin`. */
	adminBasePath?: string;
	websocket?: WebSocketFactory;
}

export interface FlueClient {
	runs: {
		get(runId: string): Promise<RunRecord>;
		events(runId: string, options?: { after?: number; types?: string[]; limit?: number }): Promise<{ events: unknown[] }>;
		stream(runId: string, options?: StreamOptions): AsyncIterable<import('./types.ts').FlueEvent>;
	};
	agents: {
		invoke(name: string, id: string, options: { mode: 'stream'; payload?: unknown; signal?: AbortSignal }): AsyncIterable<import('./types.ts').FlueEvent>;
		invoke(name: string, id: string, options: { mode: 'sync'; payload?: unknown; signal?: AbortSignal }): Promise<SyncInvokeResult>;
		connect(name: string, id: string): AgentSocket;
	};
	workflows: {
		connect(name: string): WorkflowSocket;
	};
	admin: {
		agents: { list(): Promise<ListResponse<AgentManifestEntry>> };
		runs: {
			list(options?: ListRunsOptions): Promise<ListResponse<RunPointer>>;
			get(runId: string): Promise<RunRecord>;
		};
	};
}

interface ListOptions {
	cursor?: string;
	limit?: number;
}

interface ListRunsOptions extends ListOptions {
	status?: RunStatus;
	workflowName?: string;
}

export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	const websocket = options.websocket ?? defaultWebSocketFactory;
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
		agents: {
			invoke: ((name: string, id: string, opts: Parameters<typeof invokeAgent>[3]) =>
				invokeAgent(http, name, id, opts)) as FlueClient['agents']['invoke'],
			connect: (name, id) =>
				connectAgentSocket(
					websocket,
					webSocketUrl(http.url(`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`)),
					name,
					id,
				),
		},
		workflows: {
			connect: (name) =>
				connectWorkflowSocket(websocket, webSocketUrl(http.url(`/workflows/${encodeURIComponent(name)}`)), name),
		},
		admin: {
			agents: {
				list: () => http.json({ path: `${adminBasePath}/agents` }),
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
	return {
		...listQuery(opts),
		status: opts.status,
		workflowName: opts.workflowName,
	};
}
