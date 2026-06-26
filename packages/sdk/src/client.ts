import { stream as dsStream } from '@durable-streams/client';
import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';

export type { HttpClientOptions } from './http.ts';

import type {
	AgentConversationActivity,
	AgentConversationActivityOptions,
	AgentConversationHistoryOptions,
	AgentConversationSnapshot,
	AgentConversationUpdate,
	AgentConversationUpdateOptions,
} from './public/conversation.ts';
import {
	type AgentPromptOptions,
	type AgentPromptResult,
	type AgentSendResult,
	promptAgent,
	sendAgent,
} from './public/invoke.ts';
import {
	type AgentWaitOptions,
	runWorkflow,
	type WorkflowRunOptions,
	type WorkflowRunResult,
	waitForAgentSubmission,
} from './public/settle.ts';
import {
	createFlueEventStream,
	type FlueEventStream,
	type FlueStreamOptions,
} from './public/stream.ts';
import type {
	AgentPromptResponse,
	FlueEvent,
	RunRecord,
} from './types.ts';

export type { RequestHeaders };

/** Options for starting a workflow run. */
export interface WorkflowInvokeOptions {
	/** Workflow-defined input. */
	input?: unknown;
	/**
	 * When `'result'`, the request waits for the run to finish and resolves
	 * with its terminal result. Omit to start the run without waiting.
	 */
	wait?: 'result';
	signal?: AbortSignal;
}

/** Result of starting a workflow run. */
export interface WorkflowInvokeResult {
	/** The workflow run ID. */
	runId: string;
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
		wait<TResult = AgentPromptResponse>(
			admission: AgentSendResult,
			options?: AgentWaitOptions,
		): Promise<TResult>;
		history(
			name: string,
			id: string,
			options?: AgentConversationHistoryOptions,
		): Promise<AgentConversationSnapshot>;
		updates(
			name: string,
			id: string,
			options: AgentConversationUpdateOptions,
		): FlueEventStream<AgentConversationUpdate>;
		activity(
			name: string,
			id: string,
			options: AgentConversationActivityOptions,
		): FlueEventStream<AgentConversationActivity>;
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
		/** Start a workflow run and return its ID. */
		invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
		run<TResult = unknown>(
			name: string,
			options?: WorkflowRunOptions,
		): Promise<WorkflowRunResult<TResult>>;
	};
}

/** Creates a client for the public routes of a deployed Flue application. */
export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	return {
		agents: {
			prompt: (name, id, opts) => promptAgent(http, name, id, opts),
			send: (name, id, opts) => sendAgent(http, name, id, opts),
			wait: (admission, opts) => waitForAgentSubmission(http, admission, opts),
			history: (name, id, opts = {}) =>
				http.json<AgentConversationSnapshot>({
					path: `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
					query: conversationQuery('history', opts),
					signal: opts.signal,
				}),
			updates: (name, id, opts) =>
				createFlueEventStream<AgentConversationUpdate>(
					{ live: opts.live, offset: opts.offset, signal: opts.signal, backoffOptions: opts.backoffOptions },
					{
						url: http.url(
							`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
							conversationQuery('updates', opts),
						),
						fetch: http.fetchWithHeaders.bind(http),
					},
					assertConversationUpdate,
				),
			activity: (name, id, opts) =>
				createFlueEventStream<AgentConversationActivity>(
					{ live: opts.live, offset: opts.offset, signal: opts.signal, backoffOptions: opts.backoffOptions },
					{
						url: http.url(
							`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
							conversationQuery('activity', opts),
						),
						fetch: http.fetchWithHeaders.bind(http),
					},
					assertConversationActivity,
				),
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
			invoke: (name, opts?: WorkflowInvokeOptions) =>
				http.json<WorkflowWaitResult>({
					method: 'POST',
					path: `/workflows/${encodeURIComponent(name)}`,
					query: opts?.wait === 'result' ? { wait: 'result' } : undefined,
					body: opts?.input,
					signal: opts?.signal,
				}),
			run: (name, opts) => runWorkflow(http, name, opts),
		},
	};
}

function conversationQuery(
	view: 'history' | 'updates' | 'activity',
	selector: { conversationId?: string; harness?: string; session?: string },
): Record<string, string | undefined> {
	return {
		view,
		conversationId: selector.conversationId,
		harness: selector.harness,
		session: selector.session,
	};
}

function assertConversationUpdate(value: AgentConversationUpdate): AgentConversationUpdate {
	if (
		!value ||
		typeof value !== 'object' ||
		value.v !== 1 ||
		(value.type !== 'conversation_record' && value.type !== 'conversation_reset')
	) {
		throw new TypeError('Unsupported agent conversation update.');
	}
	return value;
}

function assertConversationActivity(value: AgentConversationActivity): AgentConversationActivity {
	if (!value || typeof value !== 'object' || value.v !== 1 || value.type !== 'conversation_activity') {
		throw new TypeError('Unsupported agent conversation activity record.');
	}
	return value;
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
