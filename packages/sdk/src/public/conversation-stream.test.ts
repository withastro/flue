import { describe, expect, it } from 'vitest';
import type { FlueConversationState } from './conversation.ts';
import { applyConversationChunk, type ConversationStreamChunk } from './conversation-stream.ts';

const empty = (): FlueConversationState => ({
	conversationId: 'conv_1',
	messages: [],
	settlements: [],
});

const started = (
	messageId: string,
	timestamp: string | undefined,
	batch: number,
): ConversationStreamChunk => ({
	type: 'message-started',
	conversationId: 'conv_1',
	messageId,
	submissionId: 'sub_1',
	...(timestamp ? { timestamp } : {}),
	position: { batch, index: 0 },
});

describe('applyConversationChunk timestamps', () => {
	it('copies the message-started timestamp onto the synthesized message', () => {
		const state = applyConversationChunk(empty(), started('msg_1', '2026-01-01T00:00:01.000Z', 1));
		expect(state.messages).toEqual([
			expect.objectContaining({ id: 'msg_1', timestamp: '2026-01-01T00:00:01.000Z' }),
		]);
	});

	it('keeps the first step’s timestamp when a continuation step starts', () => {
		let state = applyConversationChunk(empty(), started('msg_1', '2026-01-01T00:00:01.000Z', 1));
		state = applyConversationChunk(state, started('msg_1', '2026-01-01T00:00:09.000Z', 2));
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.timestamp).toBe('2026-01-01T00:00:01.000Z');
	});

	it('omits the field when the chunk carries none', () => {
		const state = applyConversationChunk(empty(), started('msg_1', undefined, 1));
		expect(state.messages[0]).not.toHaveProperty('timestamp');
	});

	it('passes message-appended timestamps through and stamps settlements', () => {
		let state = applyConversationChunk(empty(), {
			type: 'message-appended',
			conversationId: 'conv_1',
			message: {
				id: 'msg_user',
				role: 'user',
				purpose: 'user',
				display: 'visible',
				timestamp: '2026-01-01T00:00:00.000Z',
				parts: [{ type: 'text', text: 'hi', state: 'done' }],
			},
			position: { batch: 1, index: 0 },
		});
		state = applyConversationChunk(state, {
			type: 'submission-settled',
			conversationId: 'conv_1',
			submissionId: 'sub_1',
			outcome: 'completed',
			timestamp: '2026-01-01T00:00:05.000Z',
			position: { batch: 2, index: 0 },
		});
		expect(state.messages[0]?.timestamp).toBe('2026-01-01T00:00:00.000Z');
		expect(state.settlements).toEqual([
			{ submissionId: 'sub_1', outcome: 'completed', timestamp: '2026-01-01T00:00:05.000Z' },
		]);
	});
});
