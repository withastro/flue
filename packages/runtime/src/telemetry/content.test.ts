import { describe, expect, it } from 'vitest';
import type { LlmAssistantMessage, LlmMessage } from '../types.ts';
import {
	CONTENT_BUDGET_BYTES,
	createContentLedger,
	drawContentAttribute,
	inputMessages,
	outputMessages,
	truncateContent,
} from './index.ts';
import { MIN_BUDGET_BYTES } from './truncate.ts';

const event = {
	type: 'idle',
	v: 3,
	eventIndex: 0,
	timestamp: new Date().toISOString(),
} as const;

function emit(args: Record<string, unknown>): string | undefined {
	const messages = inputMessages([
		{
			role: 'assistant',
			content: [{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: args }],
		},
	]);
	return drawContentAttribute(createContentLedger(), undefined, () => messages, event, {
		key: 'gen_ai.input.messages',
		contentType: 'input_messages',
	}).value;
}

describe('GenAI message fallbacks', () => {
	it('keeps the message-array shape when truncation bottoms out on a single oversized message', () => {
		const value = emit(Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, i])));
		const parsed = JSON.parse(value as string) as unknown[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			role: 'flue',
			parts: [{ type: 'text', content: expect.stringContaining('[flue]') }],
		});
	});

	it('emits a shape-preserving fallback for unserializable tool arguments (bigint)', () => {
		const value = emit({ value: 1n });
		const parsed = JSON.parse(value as string) as unknown[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			role: 'flue',
			parts: [{ type: 'text', content: '[flue] content unserializable' }],
		});
	});

	it('emits a shape-preserving fallback for unserializable tool arguments (circular)', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const value = emit(circular);
		const parsed = JSON.parse(value as string) as unknown[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ role: 'flue' });
	});

	it('keeps the message-array shape for non-message diagnostics on other content types', () => {
		// Non-message content keeps the existing bare-diagnostic behavior.
		const value = drawContentAttribute(
			createContentLedger(),
			undefined,
			() => ({ value: 1n }),
			event,
			{ key: 'gen_ai.tool.arguments', contentType: 'tool_arguments' },
		).value;
		expect(value).toBe('[flue] content unserializable');
	});

	it('preserves finish_reason on output-message fallbacks', () => {
		const message: LlmAssistantMessage = {
			role: 'assistant',
			content: Array.from({ length: 5_000 }, (_, i) => ({ type: 'text', text: `part ${i}` })),
		};
		const messages = outputMessages(message, 'stop');
		const value = drawContentAttribute(createContentLedger(), undefined, () => messages, event, {
			key: 'gen_ai.output.messages',
			contentType: 'output_messages',
		}).value;
		const parsed = JSON.parse(value as string) as unknown[];
		expect(parsed[0]).toMatchObject({
			role: 'flue',
			finish_reason: 'error',
			parts: [{ type: 'text', content: expect.stringContaining('[flue]') }],
		});
	});

	it('keeps output-message shape with finish_reason when only string leaves shrink', () => {
		const message: LlmAssistantMessage = {
			role: 'assistant',
			content: [{ type: 'text', text: 'y'.repeat(100_000) }],
		};
		const messages = outputMessages(message, 'stop');
		const value = drawContentAttribute(createContentLedger(), undefined, () => messages, event, {
			key: 'gen_ai.output.messages',
			contentType: 'output_messages',
		}).value;
		const parsed = JSON.parse(value as string) as unknown[];
		expect(parsed[0]).toMatchObject({
			role: 'assistant',
			finish_reason: 'stop',
			parts: [{ type: 'text', content: expect.stringContaining('[flue:truncated') }],
		});
	});

	it('emits the envelope even at the 128-byte budget floor', () => {
		const messages: LlmMessage[] = [
			{
				role: 'user',
				content: Array.from({ length: 10_000 }, (_, i) => ({ type: 'text', text: `part ${i}` })),
			},
		];
		const result = truncateContent(inputMessages(messages), { maxBytes: 128 }) as unknown[];
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			role: 'flue',
			parts: [{ type: 'text', content: expect.stringContaining('[flue]') }],
		});
	});
});

describe('content budget configuration', () => {
	it('defaults the pool to CONTENT_BUDGET_BYTES', () => {
		expect(createContentLedger().remaining).toBe(CONTENT_BUDGET_BYTES);
	});

	it('sizes the pool from contentBudgetBytes', () => {
		expect(createContentLedger(200_000).remaining).toBe(200_000);
		expect(createContentLedger(MIN_BUDGET_BYTES).remaining).toBe(MIN_BUDGET_BYTES);
	});

	it('rejects invalid contentBudgetBytes values', () => {
		for (const invalid of [0, 10, -1, 3.7, NaN, Infinity, -Infinity]) {
			expect(() => createContentLedger(invalid)).toThrow(TypeError);
		}
	});

	it('accepts undefined as the default pool', () => {
		expect(createContentLedger(undefined).remaining).toBe(CONTENT_BUDGET_BYTES);
	});

	it('a raised pool ships content larger than the default ceiling (the #563 case)', () => {
		const messages = inputMessages([
			{
				role: 'user',
				content: Array.from({ length: 2_000 }, (_, i) => ({
					type: 'text',
					text: `part ${i}`.repeat(8),
				})),
			},
		]);
		const full = drawContentAttribute(
			createContentLedger(400_000),
			undefined,
			() => messages,
			event,
			{ key: 'gen_ai.input.messages', contentType: 'input_messages' },
		).value;
		const truncated = drawContentAttribute(
			createContentLedger(),
			undefined,
			() => messages,
			event,
			{ key: 'gen_ai.input.messages', contentType: 'input_messages' },
		).value;

		// The raised pool keeps the full message array (no truncation sentinel);
		// the default pool cuts it down with the in-band sentinel.
		expect(JSON.stringify(full)).toContain('part 0');
		expect(JSON.stringify(full)).toContain('part 1999');
		expect(full).not.toContain('[flue]');
		expect(truncated).toContain('[flue]');
	});

	it('a lowered pool truncates sooner than the default', () => {
		const messages = inputMessages([
			{
				role: 'user',
				content: Array.from({ length: 400 }, (_, i) => ({
					type: 'text',
					text: `part ${i}`.repeat(8),
				})),
			},
		]);
		const tight = drawContentAttribute(
			createContentLedger(4_096),
			undefined,
			() => messages,
			event,
			{ key: 'gen_ai.input.messages', contentType: 'input_messages' },
		).value;
		const loose = drawContentAttribute(createContentLedger(), undefined, () => messages, event, {
			key: 'gen_ai.input.messages',
			contentType: 'input_messages',
		}).value;

		expect(tight).toContain('[flue]');
		expect(loose).not.toContain('[flue]');
	});
});
