import type { BackoffOptions } from '@durable-streams/client';
import type { HttpClient } from '../http.ts';
import type { FlueEvent, RunRecord } from '../types.ts';
import {
	type ConversationStreamChunk,
	assertConversationStreamChunk,
} from './conversation-stream.ts';
import type { AgentSendResult } from './invoke.ts';
import { createFlueEventStream } from './stream.ts';

export interface AgentWaitOptions {
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
	/**
	 * Invoked for each conversation stream chunk while waiting, for progress
	 * rendering. Prefer `client.agents.observe()` for maintained UI state.
	 */
	onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}

export interface WorkflowRunOptions {
	input?: unknown;
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
	onEvent?: (event: FlueEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<TResult = unknown> {
	runId: string;
	result: TResult;
}

export type FlueExecutionTarget = 'agent_submission' | 'workflow_run';
export type FlueExecutionFailure = 'failed' | 'terminal_event_missing';

export class FlueExecutionError extends Error {
	readonly target: FlueExecutionTarget;
	readonly targetId: string;
	readonly failure: FlueExecutionFailure;
	readonly error: unknown;

	constructor(options: {
		target: FlueExecutionTarget;
		targetId: string;
		failure: FlueExecutionFailure;
		error?: unknown;
	}) {
		super(executionErrorMessage(options));
		this.name = 'FlueExecutionError';
		this.target = options.target;
		this.targetId = options.targetId;
		this.failure = options.failure;
		this.error = options.error;
	}
}

export async function waitForAgentSubmission<TResult>(
	http: HttpClient,
	admission: AgentSendResult,
	options: AgentWaitOptions = {},
): Promise<TResult> {
	const url = new URL(admission.streamUrl);
	url.searchParams.set('view', 'updates');
	const stream = createFlueEventStream<ConversationStreamChunk>(
		{
			offset: admission.offset,
			signal: options.signal,
			backoffOptions: options.backoffOptions,
		},
		{ url: url.toString(), fetch: http.fetchWithHeaders.bind(http) },
		assertConversationStreamChunk,
	);

	for await (const chunk of stream) {
		await options.onEvent?.(chunk);
		throwIfAborted(options.signal);
		if (chunk.type !== 'submission-settled') continue;
		if (chunk.submissionId !== admission.submissionId) continue;
		if (chunk.outcome === 'completed') return chunk.result as TResult;
		throw new FlueExecutionError({
			target: 'agent_submission',
			targetId: admission.submissionId,
			failure: 'failed',
			error: chunk.error,
		});
	}

	throwIfAborted(options.signal);
	throw new FlueExecutionError({
		target: 'agent_submission',
		targetId: admission.submissionId,
		failure: 'terminal_event_missing',
	});
}

export async function runWorkflow<TResult>(
	http: HttpClient,
	name: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<TResult>> {
	const admission = await http.json<{ runId: string }>({
		method: 'POST',
		path: `/workflows/${encodeURIComponent(name)}`,
		body: options.input,
		signal: options.signal,
	});
	const stream = createFlueEventStream<FlueEvent>(
		{ signal: options.signal, backoffOptions: options.backoffOptions },
		{
			url: http.url(`/runs/${encodeURIComponent(admission.runId)}`),
			fetch: http.fetchWithHeaders.bind(http),
		},
	);

	for await (const event of stream) {
		await options.onEvent?.(event);
		throwIfAborted(options.signal);
		if (event.type !== 'run_end' || event.runId !== admission.runId) continue;
		if (!event.isError) return { runId: admission.runId, result: event.result as TResult };
		throw new FlueExecutionError({
			target: 'workflow_run',
			targetId: admission.runId,
			failure: 'failed',
			error: event.error,
		});
	}

	throwIfAborted(options.signal);
	const record = await http.json<RunRecord>({
		path: `/runs/${encodeURIComponent(admission.runId)}?meta`,
		signal: options.signal,
	});
	if (record.status === 'completed') {
		return { runId: admission.runId, result: record.result as TResult };
	}
	if (record.status === 'errored') {
		throw new FlueExecutionError({
			target: 'workflow_run',
			targetId: admission.runId,
			failure: 'failed',
			error: record.error,
		});
	}
	throw new FlueExecutionError({
		target: 'workflow_run',
		targetId: admission.runId,
		failure: 'terminal_event_missing',
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function executionErrorMessage(options: {
	target: FlueExecutionTarget;
	targetId: string;
	failure: FlueExecutionFailure;
	error?: unknown;
}): string {
	const target = options.target === 'agent_submission' ? 'Agent submission' : 'Workflow run';
	if (options.failure === 'terminal_event_missing') {
		return `${target} ${options.targetId} ended without a terminal event`;
	}
	const message = errorMessage(options.error);
	return `${target} ${options.targetId} failed${message ? `: ${message}` : ''}`;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
	return typeof error.message === 'string' ? error.message : undefined;
}
