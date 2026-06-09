import { stream as dsStream } from '@durable-streams/client';
import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';
import {
	type AgentPromptOptions,
	promptAgent,
	sendAgent,
	type AgentPromptResult,
} from './public/invoke.ts';
import {
	createFlueEventStream,
	type FlueEventStream,
	type FlueStreamOptions,
} from './public/stream.ts';
import type {
	AgentManifestEntry,
	FlueEvent,
	ListResponse,
	RunPointer,
	RunRecord,
	RunStatus,
} from './types.ts';

export type { RequestHeaders };

/** Options for listing workflow-run summaries. */
export interface ListRunsOptions {
	cursor?: string;
	/** Maximum number of runs to return. Accepts `1..1000`. */
	limit?: number;
	status?: RunStatus;
	workflowName?: string;
}

/** Options for starting a workflow run. */
export interface WorkflowInvokeOptions {
	/** Workflow-defined payload. */
	payload?: unknown;
	signal?: AbortSignal;
}

/** Result of starting a workflow run. */
export interface WorkflowInvokeResult {
	/** The workflow run ID. */
	runId: string;
	/** Fully resolved DS-compatible stream URL for observing run events. */
	streamUrl: string;
}

/** Options for creating a client for deployed Flue application routes. */
export interface CreateFlueClientOptions extends HttpClientOptions {
	/** Origin-relative mount path for read-only admin routes. Defaults to `/admin`. */
	adminBasePath?: string;
}

/** Client for invoking deployed agents and workflows and inspecting workflow runs. */
export interface FlueClient {
	/** Direct interactions with persistent agent instances. */
	agents: {
		/** Resolves the terminal result for one agent prompt. */
		prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
		send(name: string, id: string, options: AgentPromptOptions): Promise<{ streamUrl: string; offset: string }>;
		/** Stream events from an agent instance via the Durable Streams protocol. */
		stream(name: string, id: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
	};
	/** Workflow-run inspection and streaming APIs. */
	runs: {
		/** Retrieves one workflow-run record. */
		get(runId: string): Promise<RunRecord>;
		/** Stream events from a workflow run via the Durable Streams protocol. */
		stream(runId: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
		/** Get all events from a workflow run as an array (catch-up read, no live tailing). */
		events(runId: string, options?: { offset?: string; signal?: AbortSignal }): Promise<FlueEvent[]>;
	};
	/** Start workflow runs. */
	workflows: {
		/** Start a workflow run. Returns the run ID and stream URL. */
		invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
	};
	/** Read-only APIs exposed by the configured admin mount path. */
	admin: {
		agents: {
			/** Lists all built agents and their transport metadata. */
			list(): Promise<{ items: AgentManifestEntry[] }>;
		};
		runs: {
			/** Lists workflow-run summaries. */
			list(options?: ListRunsOptions): Promise<ListResponse<RunPointer>>;
			/** Retrieves one workflow-run record from the admin mount path. */
			get(runId: string): Promise<RunRecord>;
		};
	};
}

/** Creates a client for the public and read-only admin routes of a deployed Flue application. */
export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	const adminBasePath = normalizeBasePath(options.adminBasePath ?? '/admin');
	const adminHttp = new HttpClient({
		...options,
		baseUrl: new URL(`${adminBasePath}/`, http.baseUrl).toString(),
	});
	return {
		agents: {
			prompt: (name, id, opts) => promptAgent(http, name, id, opts),
			send: (name, id, opts) => sendAgent(http, name, id, opts),
			stream: (name, id, opts = {}) =>
				createFlueEventStream<FlueEvent>(opts, {
					url: http.url(`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`),
					fetch: http.fetchImpl,
					resolveHeaders: () => http.resolveStreamHeaders(),
				}),
		},
		runs: {
			get: (runId) => adminHttp.json({ path: `/runs/${encodeURIComponent(runId)}` }),
			stream: (runId, opts = {}) =>
				createFlueEventStream<FlueEvent>(opts, {
					url: http.url(`/runs/${encodeURIComponent(runId)}`),
					fetch: http.fetchImpl,
					resolveHeaders: () => http.resolveStreamHeaders(),
				}),
			events: async (runId, opts) => {
				const res = await dsStream<FlueEvent>({
					url: http.url(`/runs/${encodeURIComponent(runId)}`),
					offset: opts?.offset ?? '-1',
					live: false,
					json: true,
					signal: opts?.signal,
					fetch: wrapFetchWithHeaders(http),
					warnOnHttp: false,
				});
				return res.json();
			},
		},
		workflows: {
			invoke: async (name, opts) => {
				const body = await http.json<{ status: string; runId: string }>({
					method: 'POST',
					path: `/workflows/${encodeURIComponent(name)}`,
					body: opts?.payload,
					signal: opts?.signal,
				});
				return {
					runId: body.runId,
					streamUrl: http.url(`/runs/${encodeURIComponent(body.runId)}`),
				};
			},
		},
		admin: {
			agents: {
				list: () => adminHttp.json({ path: '/agents' }),
			},
			runs: {
				list: (opts = {}) => adminHttp.json({ path: '/runs', query: runsQuery(opts) }),
				get: (runId) => adminHttp.json({ path: `/runs/${encodeURIComponent(runId)}` }),
			},
		},
	};
}

/**
 * Wrap an HttpClient's fetch with per-request header resolution.
 * Used for one-shot DS reads (e.g. `runs.events()`) where the stream()
 * function manages its own lifecycle.
 */
function wrapFetchWithHeaders(http: HttpClient): typeof globalThis.fetch {
	return async (input, init) => {
		const resolved = await http.resolveStreamHeaders();
		const mergedHeaders = {
			...resolved,
			...(init?.headers as Record<string, string> | undefined),
		};
		return http.fetchImpl(input, { ...init, headers: mergedHeaders });
	};
}

function normalizeBasePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed || trimmed === '/') return '';
	return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function runsQuery(opts: ListRunsOptions): Record<string, string | number | undefined> {
	return {
		cursor: opts.cursor,
		limit: opts.limit,
		status: opts.status,
		workflowName: opts.workflowName,
	};
}
