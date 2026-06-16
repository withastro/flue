import { stream as dsStream } from '@durable-streams/client';
import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';

export type { HttpClientOptions } from './http.ts';

import {
	type AgentPromptOptions,
	type AgentPromptResult,
	type AgentSendResult,
	promptAgent,
	sendAgent,
} from './public/invoke.ts';
import {
	createFlueEventStream,
	type FlueEventStream,
	type FlueStreamOptions,
} from './public/stream.ts';
import type { AttachedAgentEvent, FlueEvent, RunRecord } from './types.ts';

export type { RequestHeaders };

/** Options for starting a workflow run. */
export interface WorkflowInvokeOptions {
	/** Workflow-defined payload. */
	payload?: unknown;
	/**
	 * When `'result'`, the request waits for the run to finish and resolves
	 * with its terminal result. Omit to start the run without waiting.
	 */
	wait?: 'result';
	signal?: AbortSignal;
}

/** Result of starting a workflow run. All fields are server-provided. */
export interface WorkflowInvokeResult {
	/** The workflow run ID. */
	runId: string;
	/** Fully resolved DS-compatible stream URL for observing run events. */
	streamUrl: string;
	/**
	 * Opaque DS stream offset captured at admission. Reading `streamUrl` from
	 * this offset yields the run's events from the start.
	 */
	offset: string;
}

/** Result of one workflow invocation that waited for the terminal result. */
export interface WorkflowWaitResult extends WorkflowInvokeResult {
	/** Terminal result of the workflow run. */
	result: unknown;
}

/** Options for one catch-up read of workflow-run events (no live tailing). */
export type RunEventsOptions = Omit<FlueStreamOptions, 'live'>;

/** Options for creating a client for deployed Flue application routes. */
export type CreateFlueClientOptions = HttpClientOptions;

/** Client for invoking deployed agents and workflows and inspecting workflow runs. */
export interface FlueClient {
	/** Direct interactions with persistent agent instances. */
	agents: {
		/** Resolves the terminal result for one agent prompt. */
		prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
		/** Starts one prompt without waiting for completion. */
		send(name: string, id: string, options: AgentPromptOptions): Promise<AgentSendResult>;
		/** Stream events from an agent instance via the Durable Streams protocol. */
		stream(
			name: string,
			id: string,
			options?: FlueStreamOptions,
		): FlueEventStream<AttachedAgentEvent>;
	};
	/** Workflow-run inspection and streaming APIs. */
	runs: {
		/** Retrieves one workflow-run record via the `?meta` view of the run route. */
		get(runId: string): Promise<RunRecord>;
		/** Stream events from a workflow run via the Durable Streams protocol. */
		stream(runId: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
		/** Get all events from a workflow run as an array (catch-up read, no live tailing). */
		events(runId: string, options?: RunEventsOptions): Promise<FlueEvent[]>;
	};
	/** Start workflow runs. */
	workflows: {
		/** Run a workflow to completion and resolve with its terminal result. */
		invoke(
			name: string,
			options: WorkflowInvokeOptions & { wait: 'result' },
		): Promise<WorkflowWaitResult>;
		/** Start a workflow run. Returns the run ID and its server-provided stream coordinates. */
		invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
	};
}

/** Creates a client for the public routes of a deployed Flue application. */
export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	return {
		agents: {
			prompt: (name, id, opts) => promptAgent(http, name, id, opts),
			send: (name, id, opts) => sendAgent(http, name, id, opts),
			stream: (name, id, opts = {}) =>
				createFlueEventStream<AttachedAgentEvent>(opts, {
					url: http.url(`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`),
					fetch: http.fetchWithHeaders.bind(http),
				}),
		},
		runs: {
			get: (runId) => http.json<RunRecord>({ path: `/runs/${encodeURIComponent(runId)}?meta` }),
			stream: (runId, opts = {}) =>
				createFlueEventStream<FlueEvent>(opts, {
					url: http.url(`/runs/${encodeURIComponent(runId)}`),
					fetch: http.fetchWithHeaders.bind(http),
				}),
			events: async (runId, opts) => {
				const url = new URL(http.url(`/runs/${encodeURIComponent(runId)}`));
				if (opts?.tail !== undefined) url.searchParams.set('tail', String(opts.tail));
				const events: FlueEvent[] = [];
				let offset = opts?.offset ?? '-1';
				// The DS client makes exactly one request per `live: false` stream,
				// even when the server caps the catch-up batch and reports more data
				// remains (no Stream-Up-To-Date header). Loop until up-to-date.
				for (;;) {
					const res = await dsStream<FlueEvent>({
						url: url.toString(),
						offset,
						live: false,
						json: true,
						signal: opts?.signal,
						backoffOptions: opts?.backoffOptions,
						fetch: http.fetchWithHeaders.bind(http),
						warnOnHttp: false,
					});
					events.push(...(await readJsonWithAbort<FlueEvent[]>(res, opts?.signal)));
					if (res.upToDate || res.offset === offset) break;
					offset = res.offset;
				}
				return events;
			},
		},
		workflows: {
			// The admission envelope IS the result: the server owns stream-URL
			// and offset derivation (DS offsets are opaque tokens clients must
			// not construct). With `wait: 'result'` the server also resolves
			// the run's terminal result before responding.
			invoke: (name, opts?: WorkflowInvokeOptions) =>
				http.json<WorkflowWaitResult>({
					method: 'POST',
					path: `/workflows/${encodeURIComponent(name)}`,
					query: opts?.wait === 'result' ? { wait: 'result' } : undefined,
					body: opts?.payload,
					signal: opts?.signal,
				}),
		},
	};
}

async function readJsonWithAbort<T>(
	response: { json(): Promise<T> },
	signal?: AbortSignal,
): Promise<T> {
	const result = await response.json();
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException('Aborted', 'AbortError');
	}
	return result;
}
