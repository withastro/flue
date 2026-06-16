import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { reconstructInterruptedStream, StreamChunkWriter } from '../src/runtime/stream-chunks.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakePartial(content: AssistantMessage['content'] = []): AssistantMessage {
	return {
		role: 'assistant',
		content,
		api: 'openai-chat-completions' as any,
		provider: 'test',
		model: 'test-model',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'stop',
		timestamp: Date.now(),
	};
}

function textDelta(contentIndex: number, delta: string): AssistantMessageEvent {
	return { type: 'text_delta', contentIndex, delta, partial: fakePartial() };
}

function textEnd(contentIndex: number, content: string): AssistantMessageEvent {
	return { type: 'text_end', contentIndex, content, partial: fakePartial() };
}

function thinkingStart(contentIndex: number): AssistantMessageEvent {
	return { type: 'thinking_start', contentIndex, partial: fakePartial() };
}

function thinkingDelta(contentIndex: number, delta: string): AssistantMessageEvent {
	return { type: 'thinking_delta', contentIndex, delta, partial: fakePartial() };
}

function thinkingEnd(contentIndex: number, content: string): AssistantMessageEvent {
	return { type: 'thinking_end', contentIndex, content, partial: fakePartial() };
}

function toolCallStart(contentIndex: number): AssistantMessageEvent {
	return { type: 'toolcall_start', contentIndex, partial: fakePartial() };
}

function segment(events: AssistantMessageEvent[]): { segmentIndex: number; body: string } {
	return { segmentIndex: 0, body: JSON.stringify(events) };
}

// ─── reconstructInterruptedStream ───────────────────────────────────────────

describe('reconstructInterruptedStream()', () => {
	it('reconstructs text deltas into a partial assistant message', () => {
		const result = reconstructInterruptedStream(
			[segment([textDelta(0, 'Hello '), textDelta(0, 'world')])],
			'key-1',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'text', text: 'Hello world' }]);
		expect(result.partial.stopReason).toBe('aborted');
		expect(result.interrupted.type).toBe('stream_interrupted');
		expect(result.continued.type).toBe('stream_continued');
	});

	it('uses authoritative text_end content over accumulated deltas', () => {
		const result = reconstructInterruptedStream(
			[segment([textDelta(0, 'Hello '), textEnd(0, 'Hello world')])],
			'key-1b',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'text', text: 'Hello world' }]);
	});

	it('reconstructs thinking blocks', () => {
		const result = reconstructInterruptedStream(
			[segment([thinkingStart(0), thinkingDelta(0, 'Let me '), thinkingEnd(0, 'Let me think')])],
			'key-2',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'thinking', thinking: 'Let me think' }]);
	});

	it('returns null when tool calls are present', () => {
		const result = reconstructInterruptedStream(
			[segment([textDelta(0, 'Calling tool'), toolCallStart(1)])],
			'key-3',
		);
		expect(result).toBeNull();
	});

	it('returns null for empty segments', () => {
		expect(reconstructInterruptedStream([], 'key-4')).toBeNull();
	});

	it('returns null when no partial message is available', () => {
		const events: AssistantMessageEvent[] = [
			{ type: 'text_start', contentIndex: 0, partial: fakePartial() },
		];
		expect(reconstructInterruptedStream([segment(events)], 'key-5')).toBeNull();
	});

	it('handles multiple segments in order', () => {
		const result = reconstructInterruptedStream(
			[
				{ segmentIndex: 0, body: JSON.stringify([textDelta(0, 'First ')]) },
				{ segmentIndex: 1, body: JSON.stringify([textDelta(0, 'second')]) },
			],
			'key-6',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'text', text: 'First second' }]);
	});

	it('skips malformed segment bodies', () => {
		const result = reconstructInterruptedStream(
			[
				{ segmentIndex: 0, body: 'not-json' },
				{ segmentIndex: 1, body: JSON.stringify([textDelta(0, 'ok')]) },
			],
			'key-7',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'text', text: 'ok' }]);
	});

	it('filters out empty content blocks', () => {
		const result = reconstructInterruptedStream(
			[segment([textDelta(0, ''), textDelta(1, 'real content')])],
			'key-8',
		);
		expect(result).not.toBeNull();
		if (!result) throw new Error('Expected interrupted stream result.');
		expect(result.partial.content).toEqual([{ type: 'text', text: 'real content' }]);
	});
});

// ─── StreamChunkWriter ──────────────────────────────────────────────────────

describe('StreamChunkWriter', () => {
	it('flushes buffered events on explicit flush()', async () => {
		const stored: Array<{ streamKey: string; segmentIndex: number; body: string }> = [];
		const store = {
			appendStreamChunkSegment: async (key: string, idx: number, body: string) => {
				stored.push({ streamKey: key, segmentIndex: idx, body });
				return true;
			},
		};
		const writer = new StreamChunkWriter(store, 'test-key');
		writer.write(textDelta(0, 'hello'));
		writer.write(textDelta(0, ' world'));
		await writer.flush();

		expect(stored).toHaveLength(1);
		const storedSegment = stored[0];
		if (!storedSegment) throw new Error('Expected one stored segment.');
		expect(storedSegment.streamKey).toBe('test-key');
		expect(storedSegment.segmentIndex).toBe(0);
		const parsed = JSON.parse(storedSegment.body);
		expect(parsed).toHaveLength(2);
	});

	it('marks itself failed on insert rejection and stops writing', async () => {
		let callCount = 0;
		const store = {
			appendStreamChunkSegment: async () => {
				callCount++;
				return false;
			},
		};
		const writer = new StreamChunkWriter(store, 'fail-key');
		writer.write(textDelta(0, 'a'));
		await writer.flush();
		expect(callCount).toBe(1);

		writer.write(textDelta(0, 'b'));
		await writer.flush();
		// Second flush should be a no-op since failed — call count stays at 1
		expect(callCount).toBe(1);
	});

	it('flushes buffered events on its own after the throttle interval', async () => {
		vi.useFakeTimers();
		try {
			const stored: string[] = [];
			const store = {
				appendStreamChunkSegment: async (_k: string, _i: number, body: string) => {
					stored.push(body);
					return true;
				},
			};
			const writer = new StreamChunkWriter(store, 'throttle-key');
			writer.write(textDelta(0, 'buffered'));
			expect(stored).toHaveLength(0);

			// Advance past the 3s throttle interval; no explicit flush() call.
			await vi.advanceTimersByTimeAsync(3_100);
			expect(stored).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancel() stops the timer without flushing', async () => {
		vi.useFakeTimers();
		try {
			const stored: string[] = [];
			const store = {
				appendStreamChunkSegment: async (_k: string, _i: number, body: string) => {
					stored.push(body);
					return true;
				},
			};
			const writer = new StreamChunkWriter(store, 'cancel-key');
			writer.write(textDelta(0, 'pending'));
			writer.cancel();

			// Advance past the 3s throttle interval; a leaked timer would flush here.
			await vi.advanceTimersByTimeAsync(3_100);
			expect(stored).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('close() flushes remaining events then stops accepting writes', async () => {
		const stored: string[] = [];
		const store = {
			appendStreamChunkSegment: async (_k: string, _i: number, body: string) => {
				stored.push(body);
				return true;
			},
		};
		const writer = new StreamChunkWriter(store, 'close-key');
		writer.write(textDelta(0, 'final'));
		await writer.close();
		expect(stored).toHaveLength(1);

		// Writes after close are ignored
		writer.write(textDelta(0, 'ignored'));
		await writer.flush();
		expect(stored).toHaveLength(1);
	});
});
