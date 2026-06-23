import type { AttachedAgentEvent, LlmMessage } from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';

const base = {
	v: 1 as const,
	instanceId: 'instance-1',
	timestamp: '2026-06-12T00:00:00.000Z',
};

function message(
	type: 'message_start' | 'message_end',
	value: LlmMessage,
	extra: Partial<AttachedAgentEvent & { submissionId?: string }> = {},
): AttachedAgentEvent & { submissionId?: string } {
	return { ...base, type, message: value, eventIndex: 1, ...extra } as AttachedAgentEvent & {
		submissionId?: string;
	};
}

describe('reduceAgentEvent()', () => {
	it('builds text and thinking parts from ordered deltas when a message has started', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			message('message_start', { role: 'assistant', content: [] }, { turnId: 'turn-1' }),
		);
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_start',
			contentIndex: 0,
			eventIndex: 2,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_delta',
			contentIndex: 0,
			delta: 'consider',
			eventIndex: 3,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_end',
			contentIndex: 0,
			content: 'consider carefully',
			eventIndex: 4,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'text_delta',
			text: 'hello',
			eventIndex: 5,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'text_delta',
			text: ' world',
			eventIndex: 6,
			turnId: 'turn-1',
		});

		expect(state.messages).toEqual([
			{
				id: 'turn:turn-1',
				role: 'assistant',
				metadata: undefined,
				parts: [
					{ type: 'reasoning', text: 'consider carefully', state: 'done' },
					{ type: 'text', text: 'hello world', state: 'streaming' },
				],
			},
		]);
	});

	it('correlates interleaved thinking events by content index', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			message('message_start', { role: 'assistant', content: [] }, { turnId: 'turn-1' }),
		);
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_start',
			contentIndex: 0,
			eventIndex: 2,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_start',
			contentIndex: 2,
			eventIndex: 3,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_delta',
			contentIndex: 0,
			delta: 'first',
			eventIndex: 4,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_end',
			contentIndex: 0,
			content: 'first done',
			eventIndex: 5,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_delta',
			contentIndex: 2,
			delta: 'second',
			eventIndex: 6,
			turnId: 'turn-1',
		});

		expect(state.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'first done', state: 'done' },
			{ type: 'reasoning', text: 'second', state: 'streaming' },
		]);

		state = reduceAgentEvent(state, message('message_end', {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'first final' },
				{ type: 'text', text: 'answer' },
				{ type: 'thinking', thinking: 'second final' },
			],
		}, { turnId: 'turn-1', eventIndex: 7 }));
		state = reduceAgentEvent(state, {
			...base,
			type: 'thinking_delta',
			contentIndex: 0,
			delta: ' stale',
			eventIndex: 8,
			turnId: 'turn-1',
		});
		expect(state.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'first final', state: 'done' },
			{ type: 'text', text: 'answer', state: 'done' },
			{ type: 'reasoning', text: 'second final', state: 'done' },
		]);
	});

	it('does not duplicate provisional parts when an interrupted partial batch is replayed', () => {
		const events: AttachedAgentEvent[] = [
			message(
				'message_start',
				{ role: 'assistant', content: [] },
				{ submissionId: 'submission-1', turnId: 'turn-1', eventIndex: 1 },
			),
			{
				...base,
				type: 'thinking_start',
				eventIndex: 2,
				submissionId: 'submission-1',
				turnId: 'turn-1',
			},
			{
				...base,
				type: 'thinking_delta',
				delta: 'checking',
				eventIndex: 3,
				submissionId: 'submission-1',
				turnId: 'turn-1',
			},
			{
				...base,
				type: 'text_delta',
				text: 'partial',
				eventIndex: 4,
				submissionId: 'submission-1',
				turnId: 'turn-1',
			},
			{
				...base,
				type: 'tool_start',
				toolName: 'search',
				toolCallId: 'tool-1',
				args: { q: 'flue' },
				eventIndex: 5,
				submissionId: 'submission-1',
				turnId: 'turn-1',
			},
		] as AttachedAgentEvent[];
		const once = events.reduce(reduceAgentEvent, emptyAgentState);
		const replayed = events.reduce(reduceAgentEvent, once);

		expect(replayed.messages).toEqual(once.messages);
		expect(replayed.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'checking', state: 'streaming' },
			{ type: 'text', text: 'partial', state: 'streaming' },
			{
				type: 'dynamic-tool',
				toolName: 'search',
				toolCallId: 'tool-1',
				state: 'input-available',
				input: { q: 'flue' },
			},
		]);
	});

	it('accepts restarted event indexes for distinct direct and dispatched contexts', () => {
		const direct = message(
			'message_end',
			{ role: 'user', content: 'direct' },
			{ submissionId: 'submission-1', eventIndex: 0 },
		);
		const dispatched = message(
			'message_end',
			{ role: 'user', content: 'dispatched' },
			{
				dispatchId: 'dispatch-1',
				submissionId: 'dispatch-1',
				eventIndex: 0,
				timestamp: '2026-06-12T00:01:00.000Z',
			},
		);
		let state = reduceAgentEvent(emptyAgentState, direct);
		state = reduceAgentEvent(state, dispatched);

		expect(state.messages.map((item) => item.id)).toEqual([
			'submission:submission-1:user:0',
			'submission:dispatch-1:user:0',
		]);
	});

	it('reconciles streamed content to the authoritative terminal message', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			message('message_start', { role: 'assistant', content: [] }, { turnId: 'turn-1' }),
		);
		state = reduceAgentEvent(state, {
			...base,
			type: 'text_delta',
			text: 'draft',
			eventIndex: 2,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(
			state,
			message(
				'message_end',
				{ role: 'assistant', content: [{ type: 'text', text: 'final' }] },
				{ turnId: 'turn-1', eventIndex: 3 },
			),
		);

		expect(state.messages[0]?.parts).toEqual([{ type: 'text', text: 'final', state: 'done' }]);
	});

	it('is idempotent when message_end is redelivered', () => {
		const event = message(
			'message_end',
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ turnId: 'turn-1' },
		);
		const once = reduceAgentEvent(emptyAgentState, event);
		const twice = reduceAgentEvent(once, event);

		expect(twice.messages).toEqual(once.messages);
		expect(twice.messages).toHaveLength(1);
	});

	it('provisions an assistant message when a late stream begins at tool_start', () => {
		const state = reduceAgentEvent(emptyAgentState, {
			...base,
			type: 'tool_start',
			toolName: 'search',
			toolCallId: 'tool-1',
			args: { q: 'flue' },
			eventIndex: 20,
			turnId: 'turn-9',
		});

		expect(state.messages).toEqual([
			{
				id: 'turn:turn-9',
				role: 'assistant',
				metadata: undefined,
				parts: [
					{
						type: 'dynamic-tool',
						toolName: 'search',
						toolCallId: 'tool-1',
						state: 'input-available',
						input: { q: 'flue' },
					},
				],
			},
		]);
	});

	it('preserves a late-stream tool result through terminal reconciliation', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			...base,
			type: 'tool_start',
			toolName: 'search',
			toolCallId: 'tool-1',
			args: { q: 'flue' },
			eventIndex: 20,
			turnId: 'turn-9',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'tool',
			toolName: 'search',
			toolCallId: 'tool-1',
			isError: false,
			result: ['result'],
			durationMs: 1,
			eventIndex: 21,
		});
		state = reduceAgentEvent(
			state,
			message(
				'message_end',
				{
					role: 'assistant',
					content: [{ type: 'toolCall', id: 'tool-1', name: 'search', arguments: { q: 'flue' } }],
				},
				{ turnId: 'turn-9', eventIndex: 22 },
			),
		);

		expect(state.messages[0]?.parts).toEqual([
			{
				type: 'dynamic-tool',
				toolName: 'search',
				toolCallId: 'tool-1',
				state: 'output-available',
				input: { q: 'flue' },
				output: ['result'],
				errorText: undefined,
			},
		]);
	});

	it('uses finalized tool input and preserves its result through terminal reconciliation', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			message('message_start', { role: 'assistant', content: [] }, { turnId: 'turn-1' }),
		);
		state = reduceAgentEvent(state, {
			...base,
			type: 'tool_start',
			toolName: 'search',
			toolCallId: 'tool-1',
			args: { q: 'flue' },
			eventIndex: 2,
			turnId: 'turn-1',
		});
		state = reduceAgentEvent(state, {
			...base,
			type: 'tool',
			toolName: 'search',
			toolCallId: 'tool-1',
			isError: false,
			result: ['result'],
			durationMs: 1,
			eventIndex: 3,
		});
		state = reduceAgentEvent(
			state,
			message(
				'message_end',
				{
					role: 'assistant',
					content: [{ type: 'toolCall', id: 'tool-1', name: 'search', arguments: { q: 'flue' } }],
				},
				{ turnId: 'turn-1', eventIndex: 4 },
			),
		);

		expect(state.messages[0]?.parts[0]).toEqual({
			type: 'dynamic-tool',
			toolName: 'search',
			toolCallId: 'tool-1',
			state: 'output-available',
			input: { q: 'flue' },
			output: ['result'],
			errorText: undefined,
		});
	});

	it('accepts terminal reconciliation after attaching too late for preceding deltas', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			...base,
			type: 'text_delta',
			text: 'missed start',
			eventIndex: 20,
			turnId: 'turn-9',
		});
		expect(state).toBe(emptyAgentState);
		state = reduceAgentEvent(
			state,
			message(
				'message_end',
				{ role: 'assistant', content: [{ type: 'text', text: 'complete' }] },
				{ turnId: 'turn-9', eventIndex: 21 },
			),
		);

		expect(state.messages[0]).toMatchObject({
			id: 'turn:turn-9',
			parts: [{ type: 'text', text: 'complete', state: 'done' }],
		});
	});

	it('reconciles receipt-before-echo without matching message text', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'same',
		});
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});
		state = reduceAgentEvent(
			state,
			message('message_end', { role: 'user', content: 'same' }, { submissionId: 'submission-1' }),
		);

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.id).toBe('submission:submission-1:user:0');
	});

	it('reconciles echo-before-receipt by dropping the optimistic duplicate', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'hello',
		});
		state = reduceAgentEvent(
			state,
			message('message_end', { role: 'user', content: 'hello' }, { submissionId: 'submission-1' }),
		);
		expect(state.messages).toHaveLength(2);
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.id).toBe('submission:submission-1:user:0');
	});

	it('keeps another local submission pending when one submission becomes idle', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'first',
		});
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});
		state = reduceAgentEvent(state, {
			type: 'local_send_submitted',
			localId: 'local-2',
			message: 'second',
		});
		state = reduceAgentEvent(state, {
			type: 'idle',
			eventIndex: 10,
			timestamp: base.timestamp,
			v: 1,
			instanceId: base.instanceId,
			submissionId: 'submission-1',
		});

		expect(state.status).toBe('submitted');
		expect(state.pendingSends).toEqual([{ localId: 'local-2' }]);
	});

	it('reconciles assistant activity that arrives before admission', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'hello',
		});
		state = reduceAgentEvent(
			state,
			message(
				'message_start',
				{ role: 'assistant', content: [] },
				{ submissionId: 'submission-1', turnId: 'turn-1' },
			),
		);
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});

		expect(state.status).toBe('streaming');
	});

	it('removes optimistic content when admission fails', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'hello',
		});
		state = reduceAgentEvent(state, {
			type: 'local_send_failed',
			localId: 'local-1',
			error: new Error('offline'),
		});

		expect(state.messages).toEqual([]);
		expect(state.status).toBe('error');
		expect(state.error?.message).toBe('offline');
	});
});
