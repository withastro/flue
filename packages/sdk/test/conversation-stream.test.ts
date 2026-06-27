import { describe, expect, it } from 'vitest';
import type { FlueConversationSnapshot } from '../src/public/conversation.ts';
import {
	type ConversationStreamChunk,
	ConversationStreamError,
	applyConversationChunk,
	assertConversationStreamChunk,
	createConversationStreamState,
} from '../src/public/conversation-stream.ts';

function emptySnapshot(): FlueConversationSnapshot {
	return { v: 1, conversationId: 'c1', offset: '-1', messages: [], settlements: [] };
}

function reduce(chunks: ConversationStreamChunk[], snapshot = emptySnapshot()) {
	let state = createConversationStreamState(snapshot);
	for (const chunk of chunks) state = applyConversationChunk(state, chunk);
	return state.conversation;
}

describe('applyConversationChunk()', () => {
	it('appends a whole user message when a message-appended chunk arrives', () => {
		const conversation = reduce([
			{
				type: 'message-appended',
				conversationId: 'c1',
				message: {
					id: 'm1',
					role: 'user',
					submissionId: 's1',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			},
		]);
		expect(conversation.messages).toEqual([
			{ id: 'm1', role: 'user', submissionId: 's1', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
		]);
	});

	it('assembles a streaming assistant text part from start, deltas, and end', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'part-start', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text' },
			{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 0, delta: 'he' },
			{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 1, delta: 'llo' },
			{ type: 'part-end', conversationId: 'c1', messageId: 'a1', partId: 'b1' },
		]);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('ignores a delta whose sequence was already applied so at-least-once redelivery converges', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'part-start', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text' },
			{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 0, delta: 'hi' },
			{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 0, delta: 'hi' },
		]);
		expect(conversation.messages[0]?.parts[0]).toMatchObject({ text: 'hi' });
	});

	it('throws a recoverable stream error when a delta sequence gap implies missing data', () => {
		const state = createConversationStreamState(emptySnapshot());
		const started = applyConversationChunk(state, { type: 'message-started', conversationId: 'c1', messageId: 'a1' });
		const opened = applyConversationChunk(started, { type: 'part-start', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text' });
		expect(() =>
			applyConversationChunk(opened, {
				type: 'part-delta',
				conversationId: 'c1',
				messageId: 'a1',
				partId: 'b1',
				kind: 'text',
				sequence: 2,
				delta: '!',
			}),
		).toThrow(ConversationStreamError);
	});

	it('continues a snapshot in-progress streaming block when its partId is unknown after reset', () => {
		const snapshot: FlueConversationSnapshot = {
			v: 1,
			conversationId: 'c1',
			offset: '5',
			messages: [
				{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'abcde', state: 'streaming' }] },
			],
			settlements: [],
		};
		const conversation = reduce(
			[
				{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 5, delta: 'fg' },
				{ type: 'part-end', conversationId: 'c1', messageId: 'a1', partId: 'b1' },
			],
			snapshot,
		);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'abcdefg', state: 'done' });
	});

	it('creates a fresh part for a post-reset block with no materialized streaming part instead of dropping deltas', () => {
		const snapshot: FlueConversationSnapshot = {
			v: 1,
			conversationId: 'c1',
			offset: '5',
			// The assistant message exists but its in-progress block was not
			// materialized in the snapshot (e.g. zero deltas at the reset offset).
			messages: [{ id: 'a1', role: 'assistant', parts: [] }],
			settlements: [],
		};
		const conversation = reduce(
			[
				{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 0, delta: 'he' },
				{ type: 'part-delta', conversationId: 'c1', messageId: 'a1', partId: 'b1', kind: 'text', sequence: 1, delta: 'llo' },
				{ type: 'part-end', conversationId: 'c1', messageId: 'a1', partId: 'b1' },
			],
			snapshot,
		);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('projects structured tool output onto the owning dynamic-tool part', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'weather', input: { city: 'NYC' } },
			{ type: 'tool-output', conversationId: 'c1', toolCallId: 't1', output: { temperature: 21 } },
		]);
		expect(conversation.messages[0]?.parts[0]).toEqual({
			type: 'dynamic-tool',
			toolName: 'weather',
			toolCallId: 't1',
			state: 'output-available',
			input: { city: 'NYC' },
			output: { temperature: 21 },
		});
	});

	it('replaces the whole conversation when a reset chunk arrives', () => {
		const conversation = reduce([
			{ type: 'message-appended', conversationId: 'c1', message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old', state: 'done' }] } },
			{
				type: 'conversation-reset',
				conversationId: 'c1',
				snapshot: {
					v: 1,
					conversationId: 'c1',
					offset: '9',
					messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'fresh', state: 'done' }] }],
					settlements: [],
				},
			},
		]);
		expect(conversation.messages).toEqual([
			{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'fresh', state: 'done' }] },
		]);
	});

	it('records a submission settlement', () => {
		const conversation = reduce([
			{ type: 'submission-settled', conversationId: 'c1', submissionId: 's1', outcome: 'completed', result: { ok: true } },
		]);
		expect(conversation.settlements).toEqual([{ submissionId: 's1', outcome: 'completed', result: { ok: true } }]);
	});
});

describe('assertConversationStreamChunk()', () => {
	it('rejects an unknown chunk shape', () => {
		expect(() => assertConversationStreamChunk({ type: 'nope' } as unknown as ConversationStreamChunk)).toThrow(
			ConversationStreamError,
		);
	});

	it('accepts a known chunk', () => {
		const chunk: ConversationStreamChunk = { type: 'part-end', conversationId: 'c1', messageId: 'a1', partId: 'b1' };
		expect(assertConversationStreamChunk(chunk)).toBe(chunk);
	});
});
