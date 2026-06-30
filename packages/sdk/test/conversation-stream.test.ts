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
	return state;
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

	it('assembles a streaming assistant text part from started, deltas, and completed', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'he' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'llo' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('carries the message-started timestamp onto metadata and preserves it through deltas and completion', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', timestamp: '2026-06-25T00:00:02.000Z' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hi' },
			{
				type: 'message-completed',
				conversationId: 'c1',
				messageId: 'a1',
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);
		expect(conversation.messages[0]?.metadata).toEqual({
			timestamp: '2026-06-25T00:00:02.000Z',
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	});

	it('opens a new part when the delta kind changes from reasoning to text', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'reasoning', delta: 'thinking' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'answer' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'thinking', state: 'done' },
			{ type: 'text', text: 'answer', state: 'done' },
		]);
	});

	it('opens a new text part after a tool call rather than extending the earlier text', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'before' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'noop', input: {} },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'after' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'before', state: 'done' },
			{ type: 'dynamic-tool', toolName: 'noop', toolCallId: 't1', state: 'input-available', input: {} },
			{ type: 'text', text: 'after', state: 'done' },
		]);
	});

	it('closes a streaming reasoning part when text streaming begins, before completion', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'reasoning', delta: 'thinking' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'answer' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'thinking', state: 'done' },
			{ type: 'text', text: 'answer', state: 'streaming' },
		]);
	});

	it('closes a streaming text part when a tool call begins, before completion', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'before' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'noop', input: {} },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'before', state: 'done' },
			{ type: 'dynamic-tool', toolName: 'noop', toolCallId: 't1', state: 'input-available', input: {} },
		]);
	});

	it('continues a snapshot in-progress streaming block when live deltas resume after a reset', () => {
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
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'fg' },
				{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			],
			snapshot,
		);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'abcdefg', state: 'done' });
	});

	it('creates a fresh part for an assistant message with no materialized streaming part', () => {
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
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'he' },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'llo' },
				{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
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
		const chunk: ConversationStreamChunk = {
			type: 'message-delta',
			conversationId: 'c1',
			messageId: 'a1',
			kind: 'text',
			delta: 'hi',
			position: { batch: 1, index: 0 },
		};
		expect(assertConversationStreamChunk(chunk)).toBe(chunk);
	});

	it('rejects a chunk missing a valid position', () => {
		const chunk = {
			type: 'message-delta',
			conversationId: 'c1',
			messageId: 'a1',
			kind: 'text',
			delta: 'hi',
		} as unknown as ConversationStreamChunk;
		expect(() => assertConversationStreamChunk(chunk)).toThrow(ConversationStreamError);
	});
});
