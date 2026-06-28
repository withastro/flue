import type { FlueConversationState } from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { type AgentReducerEvent, emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';
import { conversation } from './fixtures/observation.ts';

function observed(
	state: FlueConversationState | undefined,
	phase: 'loading' | 'connecting' | 'live' | 'up-to-date' | 'absent' | 'error' | 'closed' = 'live',
	error?: Error,
): AgentReducerEvent {
	return { type: 'local_observation', conversation: state, phase, error };
}

describe('reduceAgentEvent()', () => {
	it('exposes the observed conversation messages directly as UI messages', () => {
		const state = reduceAgentEvent(
			emptyAgentState,
			observed(
				conversation([
					{ id: 'entry-user', role: 'user', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
				]),
			),
		);

		expect(state.historyReady).toBe(true);
		expect(state.messages).toEqual([
			{ id: 'entry-user', role: 'user', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
		]);
	});

	it('passes through dynamic-tool and file parts without reinterpretation', () => {
		const state = reduceAgentEvent(
			emptyAgentState,
			observed(
				conversation([
					{ id: 'entry-user', role: 'user', parts: [{ type: 'file', mediaType: 'image/png' }] },
					{
						id: 'entry-assistant',
						role: 'assistant',
						parts: [
							{
								type: 'dynamic-tool',
								toolCallId: 'call-1',
								toolName: 'lookup',
								input: { q: 1 },
								state: 'output-available',
								output: { temperature: 21 },
							},
						],
					},
				]),
			),
		);

		expect(state.messages[0]?.parts).toEqual([{ type: 'file', mediaType: 'image/png' }]);
		expect(state.messages[1]?.parts).toEqual([
			{
				type: 'dynamic-tool',
				toolName: 'lookup',
				toolCallId: 'call-1',
				input: { q: 1 },
				state: 'output-available',
				output: { temperature: 21 },
			},
		]);
	});

	it('replaces the transcript when a new conversation is observed', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			observed(conversation([{ id: 'entry-old', role: 'user', parts: [] }])),
		);
		state = reduceAgentEvent(
			state,
			observed(
				conversation([
					{ id: 'entry-selected', role: 'assistant', parts: [{ type: 'text', text: 'selected', state: 'done' }] },
				]),
			),
		);

		expect(state.messages.map((message) => message.id)).toEqual(['entry-selected']);
	});

	it('clears the transcript when the observed conversation is absent', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			observed(conversation([{ id: 'entry-user', role: 'user', parts: [] }])),
		);
		state = reduceAgentEvent(state, observed(undefined, 'absent'));

		expect(state.messages).toEqual([]);
		expect(state.status).toBe('idle');
		expect(state.historyReady).toBe(true);
	});

	it('surfaces an observation error', () => {
		const error = new Error('stream failed');
		const state = reduceAgentEvent(emptyAgentState, observed(undefined, 'error', error));

		expect(state.status).toBe('error');
		expect(state.error).toBe(error);
	});

	it('keeps a stable optimistic id after the canonical user message arrives', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		// Before confirmation the optimistic echo renders under its local id.
		expect(state.messages[0]?.id).toBe('local-1');
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});
		state = reduceAgentEvent(
			state,
			observed(
				conversation([
					{
						id: 'entry-user',
						role: 'user',
						submissionId: 'submission-1',
						parts: [{ type: 'text', text: 'hello', state: 'done' }],
					},
				]),
			),
		);

		// The canonical user message is re-keyed to the optimistic local id, so the
		// rendered row identity is stable across the optimistic→confirmed swap (no
		// remove+add that would churn a keyed/virtualized list).
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.id).toBe('local-1');
	});

	it('reconciles the optimistic message when the canonical transcript arrives before admission', () => {
		let state = reduceAgentEvent(emptyAgentState, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'hello',
		});
		state = reduceAgentEvent(
			state,
			observed(
				conversation([
					{
						id: 'entry-user',
						role: 'user',
						submissionId: 'submission-1',
						parts: [{ type: 'text', text: 'hello', state: 'done' }],
					},
				]),
			),
		);
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});

		expect(state.messages.map((message) => message.id)).toEqual(['local-1']);
		expect(state.pendingSends).toEqual([]);
		expect(state.status).toBe('streaming');
	});

	it('remains idle when a completed settlement is observed before admission', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		state = reduceAgentEvent(
			state,
			observed(conversation([], [{ submissionId: 'submission-1', outcome: 'completed' }])),
		);
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});

		expect(state.pendingSends).toEqual([]);
		expect(state.activeSubmissionIds).toEqual([]);
		expect(state.status).toBe('idle');
	});

	it('renders an instant local data-URL preview for optimistic image sends', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'see this',
			images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png', filename: 'shot.png' }],
		});

		expect(state.messages[0]?.parts[1]).toEqual({
			type: 'file',
			mediaType: 'image/png',
			url: 'data:image/png;base64,AAAA',
			filename: 'shot.png',
		});
	});

	it('retains a failed send in the transcript with retry metadata', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		const error = new Error('network down');
		state = reduceAgentEvent(state, { type: 'local_send_failed', localId: 'local-1', error });

		// The optimistic message stays visible (not silently dropped) and is
		// reported via failedSends so a UI can offer retry.
		expect(state.messages.map((message) => message.id)).toEqual(['local-1']);
		expect(state.failedSends).toEqual([{ id: 'local-1', message: 'hello', error }]);
		expect(state.status).toBe('error');
		expect(state.error).toBe(error);
	});

	it('reflects a new in-flight send as submitted even while a prior send is failed', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'one' });
		state = reduceAgentEvent(state, {
			type: 'local_send_failed',
			localId: 'local-1',
			error: new Error('network down'),
		});
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-2', message: 'two' });

		// The failed message is still shown, but status tracks the in-flight send.
		expect(state.messages.map((message) => message.id)).toEqual(['local-2', 'local-1']);
		expect(state.status).toBe('submitted');
		expect(state.failedSends.map((failed) => failed.id)).toEqual(['local-1']);
	});

	it('surfaces the failure when a failed settlement is observed before admission', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		state = reduceAgentEvent(
			state,
			observed(
				conversation(
					[],
					[{ submissionId: 'submission-1', outcome: 'failed', error: { message: 'failed before receipt' } }],
				),
			),
		);
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});

		expect(state.pendingSends).toEqual([]);
		expect(state.activeSubmissionIds).toEqual([]);
		expect(state.status).toBe('error');
		expect(state.error?.message).toBe('failed before receipt');
	});
});
