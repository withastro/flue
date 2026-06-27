import type {
	AgentConversationSnapshot,
	AgentConversationState,
	AgentConversationUpdate,
	CanonicalConversationRecord,
} from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { type AgentReducerEvent, emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';
import { materialize } from './fixtures/observation.ts';

function snapshot(messages: AgentConversationSnapshot['messages'] = []): AgentConversationSnapshot {
	return {
		v: 1,
		type: 'conversation_snapshot',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		offset: 'offset-1',
		messages,
		settlements: [],
	};
}

function record(id: string, type: string, fields: Record<string, unknown>): CanonicalConversationRecord {
	return {
		v: 1,
		id,
		type,
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-06-26T00:00:00.000Z',
		...fields,
	};
}

function update(value: CanonicalConversationRecord): AgentConversationUpdate {
	return { v: 1, type: 'conversation_record', conversationId: 'conversation-1', record: value };
}

function observed(
	conversation: AgentConversationState | undefined,
	phase: 'loading' | 'connecting' | 'live' | 'up-to-date' | 'absent' | 'error' | 'closed' = 'live',
	error?: Error,
): AgentReducerEvent {
	return { type: 'local_observation', conversation, phase, error };
}

describe('reduceAgentEvent()', () => {
	it('projects an observed canonical transcript into UI messages', () => {
		const state = reduceAgentEvent(
			emptyAgentState,
			observed(
				materialize(
					snapshot([
						{
							id: 'entry-user',
							role: 'user',
							parts: [{ type: 'text', text: 'hello', state: 'done' }],
						},
					]),
				),
			),
		);

		expect(state.historyReady).toBe(true);
		expect(state.messages).toEqual([
			{
				id: 'entry-user',
				role: 'user',
				metadata: undefined,
				parts: [{ type: 'text', text: 'hello', state: 'done' }],
			},
		]);
	});

	it('strips conversation delta bookkeeping from UI message parts', () => {
		const state = reduceAgentEvent(
			emptyAgentState,
			observed(
				materialize(
					snapshot([
						{
							id: 'entry-assistant',
							role: 'assistant',
							parts: [
								{
									type: 'text',
									blockId: 'block-1',
									text: 'hello',
									state: 'streaming',
									deltaState: { nextSequence: 1, accepted: ['hello'] },
								},
							],
						},
					]),
				),
			),
		);

		expect(state.messages[0]?.parts).toEqual([{ type: 'text', text: 'hello', state: 'streaming' }]);
	});

	it('projects tool and attachment parts into React UI shapes', () => {
		const state = reduceAgentEvent(
			emptyAgentState,
			observed(
				materialize(
					snapshot([
						{
							id: 'entry-user',
							role: 'user',
							parts: [
								{
									type: 'attachment',
									attachment: { id: 'att-1', mimeType: 'image/png', size: 3, digest: 'sha' },
								},
							],
						},
						{
							id: 'entry-assistant',
							role: 'assistant',
							parts: [
								{
									type: 'tool',
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
			),
		);

		expect(state.messages[0]?.parts).toEqual([
			{ type: 'data-attachment', id: 'att-1', data: { mediaType: 'image/png', size: 3, digest: 'sha' } },
		]);
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
			observed(materialize(snapshot([{ id: 'entry-old', role: 'user', parts: [] }]))),
		);
		state = reduceAgentEvent(
			state,
			observed(
				materialize(
					snapshot([
						{
							id: 'entry-selected',
							role: 'assistant',
							parts: [{ type: 'text', text: 'selected', state: 'done' }],
						},
					]),
				),
			),
		);

		expect(state.messages.map((message) => message.id)).toEqual(['entry-selected']);
	});

	it('clears the transcript when the observed conversation is absent', () => {
		let state = reduceAgentEvent(
			emptyAgentState,
			observed(materialize(snapshot([{ id: 'entry-user', role: 'user', parts: [] }]))),
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
		let state = reduceAgentEvent(emptyAgentState, observed(materialize(snapshot())));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});
		state = reduceAgentEvent(
			state,
			observed(
				materialize(snapshot(), [
					update(
						record('user', 'user_message', {
							messageId: 'entry-user',
							parentId: null,
							submissionId: 'submission-1',
							content: [{ type: 'text', text: 'hello' }],
						}),
					),
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
				materialize(
					snapshot([
						{
							id: 'entry-user',
							role: 'user',
							submissionId: 'submission-1',
							parts: [{ type: 'text', text: 'hello', state: 'done' }],
						},
					]),
				),
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
		let state = reduceAgentEvent(emptyAgentState, observed(materialize(snapshot())));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		state = reduceAgentEvent(
			state,
			observed(
				materialize(snapshot(), [
					update(record('settled', 'submission_settled', { submissionId: 'submission-1', outcome: 'completed' })),
				]),
			),
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
		let state = reduceAgentEvent(emptyAgentState, observed(materialize(snapshot())));
		state = reduceAgentEvent(state, { type: 'local_send_submitted', localId: 'local-1', message: 'hello' });
		state = reduceAgentEvent(
			state,
			observed(
				materialize(snapshot(), [
					update(
						record('settled', 'submission_settled', {
							submissionId: 'submission-1',
							outcome: 'failed',
							error: { message: 'failed before receipt' },
						}),
					),
				]),
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
