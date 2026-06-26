import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
	type CanonicalSubmissionEntry,
	classifySubmissionState,
} from '../src/submission-state.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function messageEntry(id: string, message: unknown): CanonicalSubmissionEntry {
	return {
		type: 'message',
		id,
		message: message as any,
	};
}

function assistant(options: {
	stopReason: AssistantMessage['stopReason'];
	errorMessage?: string;
	usage?: { input: number; output: number; cacheRead: number };
}): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text: 'partial output' }],
		api: 'test' as any,
		provider: 'test',
		model: 'test-model',
		usage: {
			input: options.usage?.input ?? 100,
			output: options.usage?.output ?? 20,
			cacheRead: options.usage?.cacheRead ?? 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason,
		...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('classifySubmissionState()', () => {
	it('returns absent when the input entry is missing from history', () => {
		expect(classifySubmissionState(undefined, { contextWindow: 100000 })).toEqual({
			kind: 'absent',
		});
	});

	it('returns advanced_past_input when a later user input follows the submission input', () => {
		// Pins the precedence: a later user input wins over the completed
		// response that precedes it.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', assistant({ stopReason: 'stop' })),
			messageEntry('u1', { role: 'user', content: 'next input', timestamp: Date.now() }),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toEqual({
			kind: 'advanced_past_input',
		});
	});

	it('returns resume input_only when no entries follow the applied input', () => {
		// The journal-absent-with-input-applied crash window: the input marker
		// fired but no assistant response was persisted.
		expect(classifySubmissionState([], { contextWindow: 100000 })).toEqual({
			kind: 'resume',
			mode: 'input_only',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns completed without overflow when the response stopped normally', () => {
		const following: CanonicalSubmissionEntry[] = [messageEntry('a1', assistant({ stopReason: 'stop' }))];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'completed',
			overflow: false,
		});
	});

	it('returns completed when the response stopped at the length limit', () => {
		const following: CanonicalSubmissionEntry[] = [
			messageEntry(
				'a1',
				assistant({ stopReason: 'length', usage: { input: 100, output: 50, cacheRead: 0 } }),
			),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'completed',
			overflow: false,
		});
	});

	it('flags overflow on a completed response when input usage exceeds the context window', () => {
		// Intentional consumer divergence (see submission-state.ts): inspection
		// reports this state 'completed' for reconciliation, while the
		// processing preamble compacts and continues it.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry(
				'a1',
				assistant({ stopReason: 'stop', usage: { input: 150000, output: 10, cacheRead: 0 } }),
			),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'completed',
			overflow: true,
		});
	});

	it('returns resume tool_results when every call in a toolUse response has a persisted result', () => {
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', {
				...assistant({ stopReason: 'toolUse' }),
				content: [
					{ type: 'toolCall', id: 'tc1', name: 'lookup', arguments: {} },
					{ type: 'toolCall', id: 'tc2', name: 'search', arguments: {} },
				],
			}),
			messageEntry('t1', {
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'result one' }],
				isError: false,
				timestamp: Date.now(),
			}),
			messageEntry('t2', {
				role: 'toolResult',
				toolCallId: 'tc2',
				toolName: 'search',
				content: [{ type: 'text', text: 'result two' }],
				isError: false,
				timestamp: Date.now(),
			}),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'tool_results',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume tool_results_partial when a toolUse response has results for only some calls', () => {
		// The mid-batch interruption shape: the turn requested three tools,
		// only the first completed before the abort broke the tool loop. A
		// plain resume would drop the incomplete batch from model context and
		// re-execute the completed call; resumption must repair the batch
		// first.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', {
				...assistant({ stopReason: 'toolUse' }),
				content: [
					{ type: 'toolCall', id: 'tc1', name: 'lookup', arguments: {} },
					{ type: 'toolCall', id: 'tc2', name: 'search', arguments: {} },
					{ type: 'toolCall', id: 'tc3', name: 'fetch', arguments: {} },
				],
			}),
			messageEntry('t1', {
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'result one' }],
				isError: false,
				timestamp: Date.now(),
			}),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'tool_results_partial',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume tool_results_partial when an aborted partial trails the incomplete batch', () => {
		// Graceful shutdown mid-batch checkpoints the partial results and then
		// the next turn's empty aborted assistant (the agent loop starts it
		// before the abort surfaces). The partial batch — not the trailing
		// aborted partial — must drive resumption.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', {
				...assistant({ stopReason: 'toolUse' }),
				content: [
					{ type: 'toolCall', id: 'tc1', name: 'lookup', arguments: {} },
					{ type: 'toolCall', id: 'tc2', name: 'search', arguments: {} },
				],
			}),
			messageEntry('t1', {
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'result one' }],
				isError: false,
				timestamp: Date.now(),
			}),
			messageEntry('a2', assistant({ stopReason: 'aborted' })),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'tool_results_partial',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume aborted_partial when a complete batch precedes the trailing aborted partial', () => {
		// A complete batch survives in model context, so plain resumption
		// continues from the recorded results — no repair, no re-execution.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', {
				...assistant({ stopReason: 'toolUse' }),
				content: [{ type: 'toolCall', id: 'tc1', name: 'lookup', arguments: {} }],
			}),
			messageEntry('t1', {
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'result one' }],
				isError: false,
				timestamp: Date.now(),
			}),
			messageEntry('a2', assistant({ stopReason: 'aborted' })),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'aborted_partial',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume stream_continuation when a recovered stream trails a partial batch', () => {
		// Pins the precedence: a recovered stream continuation resumes from
		// the recovered partial and must never be rewound by batch repair.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', {
				...assistant({ stopReason: 'toolUse' }),
				content: [
					{ type: 'toolCall', id: 'tc1', name: 'lookup', arguments: {} },
					{ type: 'toolCall', id: 'tc2', name: 'search', arguments: {} },
				],
			}),
			messageEntry('t1', {
				role: 'toolResult',
				toolCallId: 'tc1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'result one' }],
				isError: false,
				timestamp: Date.now(),
			}),
			messageEntry('a2', assistant({ stopReason: 'aborted' })),
			messageEntry('s1', {
				role: 'signal',
				type: 'stream_continued',
				content: 'The interrupted stream was recovered.',
				timestamp: Date.now(),
			}),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'stream_continuation',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns tool_use_unresolved when a toolUse response has no persisted tool results', () => {
		// Intentional consumer divergence (see submission-state.ts): inspection
		// reports this state 'uncertain', while the processing preamble settles
		// with the persisted response without resuming.
		const following: CanonicalSubmissionEntry[] = [messageEntry('a1', assistant({ stopReason: 'toolUse' }))];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'tool_use_unresolved',
		});
	});

	it('returns resume stream_continuation when an aborted response has a stream_continued signal', () => {
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', assistant({ stopReason: 'aborted' })),
			messageEntry('s1', {
				role: 'signal',
				type: 'stream_continued',
				content: 'The interrupted stream was recovered.',
				timestamp: Date.now(),
			}),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'stream_continuation',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume aborted_partial when an aborted response has no stream continuation', () => {
		// The bare-aborted state, e.g. a partial checkpointed when graceful
		// shutdown aborted the turn. The partial is excluded from model
		// context, so resumption replays the turn from the last durable
		// message instead of terminally failing recoverable work.
		const following: CanonicalSubmissionEntry[] = [messageEntry('a1', assistant({ stopReason: 'aborted' }))];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'aborted_partial',
			consecutiveRetryableErrors: 0,
		});
	});

	it('returns resume transient_retry when the last response is a retryable model error', () => {
		// Intentional consumer divergence (see submission-state.ts): the
		// processing preamble waits and retries, while inspection reports
		// 'uncertain' and reconciliation compensates with its
		// uncertain-before-provider special case.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', assistant({ stopReason: 'error', errorMessage: 'Overloaded' })),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'transient_retry',
			consecutiveRetryableErrors: 1,
		});
	});

	it('counts consecutive trailing retryable errors when several persisted in a row', () => {
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', assistant({ stopReason: 'error', errorMessage: '429 Too Many Requests' })),
			messageEntry('a2', assistant({ stopReason: 'error', errorMessage: 'Overloaded' })),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'transient_retry',
			consecutiveRetryableErrors: 2,
		});
	});

	it('returns resume overflow when the error message indicates context overflow', () => {
		// Intentional consumer divergence (see submission-state.ts): the
		// processing preamble compacts and continues, while inspection reports
		// 'uncertain'.
		const following: CanonicalSubmissionEntry[] = [
			messageEntry(
				'a1',
				assistant({
					stopReason: 'error',
					errorMessage: 'prompt is too long: 200000 tokens > 100000 maximum',
				}),
			),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toMatchObject({
			kind: 'resume',
			mode: 'overflow',
		});
	});

	it('returns terminal_error with the provider message when the error is not retryable', () => {
		const following: CanonicalSubmissionEntry[] = [
			messageEntry('a1', assistant({ stopReason: 'error', errorMessage: 'invalid x-api-key' })),
		];
		expect(classifySubmissionState(following, { contextWindow: 100000 })).toEqual({
			kind: 'terminal_error',
			reason: 'invalid x-api-key',
		});
	});
});
