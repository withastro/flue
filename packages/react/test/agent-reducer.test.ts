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

	it('keeps optimistic identity until its canonical user message arrives', () => {
		let state = reduceAgentEvent(emptyAgentState, observed(conversation()));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
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

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.id).toBe('entry-user');
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

		expect(state.messages.map((message) => message.id)).toEqual(['entry-user']);
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
