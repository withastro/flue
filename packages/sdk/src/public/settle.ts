import type { BackoffOptions } from '@durable-streams/client';
import type { HttpClient } from '../http.ts';
import {
	assertConversationStreamChunk,
	type ConversationStreamChunk,
} from './conversation-stream.ts';
import { createFlueEventStream } from './stream.ts';

export interface AgentWaitOptions {
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
	/**
	 * Invoked for each conversation stream chunk while waiting, for progress
	 * rendering. Prefer `observe()` for maintained UI state.
	 */
	onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}

/**
 * The minimal admission shape settlement-following needs: an offset-bearing
 * stream location and the submission id to watch for. `AgentSendResult`
 * satisfies this; so does `read()`'s internal re-attach target, which may
 * carry no `uid`.
 */
export interface AgentSettlementTarget {
	streamUrl: string;
	offset: string;
	submissionId: string;
}

export type FlueExecutionTarget = 'agent_submission';
export type FlueExecutionFailure = 'failed' | 'aborted' | 'terminal_event_missing';

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

export async function waitForAgentSubmission(
	http: HttpClient,
	admission: AgentSettlementTarget,
	options: AgentWaitOptions = {},
): Promise<void> {
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
		const settlement = settlementFromChunk(chunk, admission.submissionId);
		if (!settlement) continue;
		if (settlement.outcome === 'completed') return;
		throw new FlueExecutionError({
			target: 'agent_submission',
			targetId: admission.submissionId,
			failure: settlement.outcome === 'aborted' ? 'aborted' : 'failed',
			error: settlement.error,
		});
	}

	throwIfAborted(options.signal);
	throw new FlueExecutionError({
		target: 'agent_submission',
		targetId: admission.submissionId,
		failure: 'terminal_event_missing',
	});
}

/**
 * A submission's settlement appears as its own `submission-settled` chunk —
 * or folded into a `conversation-reset` snapshot, when a reset (for example a
 * compaction) landed in the same durable batch and subsumed it.
 */
function settlementFromChunk(
	chunk: ConversationStreamChunk,
	submissionId: string,
): { outcome: 'completed' | 'failed' | 'aborted'; error?: unknown } | undefined {
	if (chunk.type === 'submission-settled' && chunk.submissionId === submissionId) {
		return { outcome: chunk.outcome, ...(chunk.error === undefined ? {} : { error: chunk.error }) };
	}
	if (chunk.type === 'conversation-reset') {
		return chunk.snapshot.settlements.find((entry) => entry.submissionId === submissionId);
	}
	return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function executionErrorMessage(options: {
	targetId: string;
	failure: FlueExecutionFailure;
	error?: unknown;
}): string {
	if (options.failure === 'terminal_event_missing') {
		return `Agent submission ${options.targetId} ended without a terminal event`;
	}
	const message = errorMessage(options.error);
	const verb = options.failure === 'aborted' ? 'was aborted' : 'failed';
	return `Agent submission ${options.targetId} ${verb}${message ? `: ${message}` : ''}`;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
	return typeof error.message === 'string' ? error.message : undefined;
}
