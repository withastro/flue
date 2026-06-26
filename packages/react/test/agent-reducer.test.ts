import type {
	AgentConversationSnapshot,
	AgentConversationUpdate,
	CanonicalConversationRecord,
} from '@flue/sdk';
import { describe, expect, it } from 'vitest';
import { emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';

function snapshot(): AgentConversationSnapshot {
	return {
		v: 1,
		type: 'conversation_snapshot',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		offset: 'offset-1',
		messages: [],
		data: [],
		settlements: [],
	};
}

function update(record: CanonicalConversationRecord): AgentConversationUpdate {
	return {
		v: 1,
		type: 'conversation_record',
		conversationId: 'conversation-1',
		record,
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

describe('reduceAgentEvent()', () => {
	it('hydrates a complete canonical snapshot in one reduction', () => {
		const state = reduceAgentEvent(emptyAgentState, {
			type: 'local_history',
			snapshot: {
				...snapshot(),
				messages: [
					{
						id: 'entry-user',
						role: 'user',
						parts: [{ type: 'text', text: 'hello', state: 'done' }],
					},
				],
			},
		});

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

	it('applies durable assistant lifecycle and deltas incrementally', () => {
		let state = reduceAgentEvent(emptyAgentState, { type: 'local_history', snapshot: snapshot() });
		state = reduceAgentEvent(
			state,
			update(
				record('start', 'assistant_message_started', {
					messageId: 'entry-assistant',
					parentId: null,
					modelInfo: { provider: 'test', model: 'model' },
				}),
			),
		);
		state = reduceAgentEvent(
			state,
			update(
				record('text-start', 'assistant_text_started', {
					messageId: 'entry-assistant',
					blockId: 'block-1',
					blockIndex: 0,
				}),
			),
		);
		state = reduceAgentEvent(
			state,
			update(
				record('delta-1', 'assistant_text_delta', {
					messageId: 'entry-assistant',
					blockId: 'block-1',
					sequence: 0,
					delta: 'hello',
				}),
			),
		);

		expect(state.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'hello', state: 'streaming' },
		]);

		state = reduceAgentEvent(
			state,
			update(
				record('text-done', 'assistant_text_completed', {
					messageId: 'entry-assistant',
					blockId: 'block-1',
					deltaCount: 1,
				}),
			),
		);
		expect(state.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('reconciles data by name and id while appending unidentified data', () => {
		let state = reduceAgentEvent(emptyAgentState, { type: 'local_history', snapshot: snapshot() });
		state = reduceAgentEvent(
			state,
			update(record('data-1', 'data', { dataType: 'status', dataId: 'same', data: 'running' })),
		);
		state = reduceAgentEvent(
			state,
			update(record('data-2', 'data', { dataType: 'status', dataId: 'same', data: 'done' })),
		);
		state = reduceAgentEvent(
			state,
			update(record('data-3', 'data', { dataType: 'notice', data: 'one' })),
		);
		state = reduceAgentEvent(
			state,
			update(record('data-4', 'data', { dataType: 'notice', data: 'two' })),
		);

		expect(state.messages.map((message) => message.parts[0])).toEqual([
			{ type: 'data-status', id: 'same', data: 'done' },
			{ type: 'data-notice', data: 'one' },
			{ type: 'data-notice', data: 'two' },
		]);
	});

	it('replaces transcript state when the server emits a canonical reset', () => {
		let state = reduceAgentEvent(emptyAgentState, { type: 'local_history', snapshot: snapshot() });
		state = reduceAgentEvent(state, {
			v: 1,
			type: 'conversation_reset',
			conversationId: 'conversation-1',
			snapshot: {
				...snapshot(),
				offset: 'offset-2',
				messages: [
					{
						id: 'entry-selected',
						role: 'assistant',
						parts: [{ type: 'text', text: 'selected', state: 'done' }],
					},
				],
			},
		});

		expect(state.messages.map((message) => message.id)).toEqual(['entry-selected']);
	});

	it('keeps optimistic identity until its canonical user message arrives', () => {
		let state = reduceAgentEvent(emptyAgentState, { type: 'local_history', snapshot: snapshot() });
		state = reduceAgentEvent(state, {
			type: 'local_send_submitted',
			localId: 'local-1',
			message: 'hello',
		});
		state = reduceAgentEvent(state, {
			type: 'local_send_admitted',
			localId: 'local-1',
			submissionId: 'submission-1',
		});
		state = reduceAgentEvent(
			state,
			update(
				record('user', 'user_message', {
					messageId: 'entry-user',
					parentId: null,
					submissionId: 'submission-1',
					content: [{ type: 'text', text: 'hello' }],
				}),
			),
		);

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.id).toBe('entry-user');
	});
});
