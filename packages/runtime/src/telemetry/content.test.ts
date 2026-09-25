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

describe('structural array truncation', () => {
	it('truncates large message arrays without repeatedly serializing every remaining message', () => {
		const messages = Array.from({ length: 2_100 }, (_, index) => ({
			role: 'user',
			parts: [{ type: 'text', content: `${index}:${'x'.repeat(1_200)}` }],
		}));
		const started = performance.now();
		const result = truncateContent(messages, { maxBytes: 40_960 }) as typeof messages;
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(750);
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(40_960);
		expect(result[0]).toMatchObject({
			role: 'flue',
			parts: [
				{
					type: 'text',
					content: expect.stringMatching(/^\[flue\] \d+ messages omitted/),
				},
			],
		});
		expect(result.at(-1)).toEqual(messages.at(-1));
	});

	it('preserves position-dependent serialization behavior on the compatibility path', () => {
		const values = Array.from({ length: 20 }, (_, index) => ({
			toJSON(key: string) {
				return `${key}:${index}:${'x'.repeat(80)}`;
			},
		}));
		const result = truncateContent(values, { maxBytes: 256 }) as unknown[];

		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(256);
		expect(result[0]).toEqual(expect.stringMatching(/^\[flue\] \d+ items omitted/));
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

describe('tool payload shapes', () => {
	/** The tool-argument/result draw exactly as the trace backends run it. */
	function toolContent(
		kind: 'arguments' | 'result',
		value: unknown,
		policy?: Parameters<typeof drawContentAttribute>[1],
		budgetBytes?: number,
	): string | undefined {
		return drawContentAttribute(createContentLedger(budgetBytes), policy, () => value, event, {
			key: kind === 'arguments' ? 'gen_ai.tool.call.arguments' : 'gen_ai.tool.call.result',
			contentType: kind === 'arguments' ? 'tool_arguments' : 'tool_result',
			rawString: true,
		}).value;
	}

	it('records a plain object argument as JSON', () => {
		expect(toolContent('arguments', { location: 'San Francisco?', date: '2025-10-01' })).toBe(
			'{"location":"San Francisco?","date":"2025-10-01"}',
		);
	});

	it('records a plain object result as JSON', () => {
		expect(toolContent('result', { conditions: 'sunny', high: 75, low: 60 })).toBe(
			'{"conditions":"sunny","high":75,"low":60}',
		);
	});

	it('records a JSON-string payload byte-for-byte, without deserializing it', () => {
		// The key-routing fix does not parse post-transform strings: the
		// recorded value must be exactly what the tool returned, whitespace and
		// all. (The semconv permits JSON-string form on spans, and both span
		// sinks are string-only.)
		expect(toolContent('result', '{ "conditions": "sunny" }')).toBe('{ "conditions": "sunny" }');
	});

	it('records a JSON-array string payload byte-for-byte', () => {
		expect(toolContent('result', '[1, 2, 3]')).toBe('[1, 2, 3]');
	});

	it('records ordinary text as a raw string, not JSON-quoted', () => {
		expect(toolContent('result', 'It is sunny with a high of 75.')).toBe(
			'It is sunny with a high of 75.',
		);
	});

	it('keeps strings that merely start with a brace or bracket but are not valid JSON raw', () => {
		expect(toolContent('result', '{oops')).toBe('{oops');
		expect(toolContent('result', '{"a":1} trailing')).toBe('{"a":1} trailing');
	});

	it('records an array payload as JSON', () => {
		expect(toolContent('result', [1, 'two', true])).toBe('[1,"two",true]');
	});

	it('records scalar payloads as JSON', () => {
		expect(toolContent('result', 42)).toBe('42');
		expect(toolContent('result', true)).toBe('true');
		expect(toolContent('result', 2.5)).toBe('2.5');
	});

	it('records a null payload as JSON null', () => {
		expect(toolContent('result', null)).toBe('null');
	});

	it('records the string "null" as raw text, not deserialized', () => {
		// String payloads record byte-for-byte; the JSON primitive string
		// "null" is not deserialized into a null value.
		expect(toolContent('result', 'null')).toBe('null');
	});

	it('records JSON primitives in string payloads as raw text, not deserialized', () => {
		expect(toolContent('result', '123')).toBe('123');
		expect(toolContent('result', 'true')).toBe('true');
	});

	it('emits the unserializable sentinel for payloads JSON cannot represent', () => {
		expect(toolContent('arguments', { value: 1n })).toBe('[flue] content unserializable');
	});

	it('emits the unserializable sentinel for circular payloads', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(toolContent('result', circular)).toBe('[flue] content unserializable');
	});

	it('preserves lossy JSON inputs byte-for-byte (unsafe integers, overflow, -0)', () => {
		// A parse/re-stringify round trip would corrupt these; the key-routing
		// fix must not touch post-transform strings.
		expect(
			toolContent('result', '{"id":9007199254740993,"overflow":1e400,"negativeZero":-0}'),
		).toBe('{"id":9007199254740993,"overflow":1e400,"negativeZero":-0}');
	});

	it('preserves duplicate keys, key order, and JSON escapes in string payloads', () => {
		expect(toolContent('result', '{"a":1,"a":2}')).toBe('{"a":1,"a":2}');
		expect(toolContent('result', '{"k":2,"j":1}')).toBe('{"k":2,"j":1}');
		expect(toolContent('result', '{"html":"\\u003cscript\\u003e","url":"\\/"}')).toBe(
			'{"html":"\\u003cscript\\u003e","url":"\\/"}',
		);
	});

	it('prefix-truncates an oversized JSON-string payload with the in-band sentinel', () => {
		const value = toolContent(
			'result',
			JSON.stringify({ a: 'y'.repeat(200_000), b: 'tail' }),
			undefined,
			4_096,
		);
		expect(value?.startsWith('{')).toBe(true);
		expect(value).toContain('[flue:truncated');
	});

	it('prefix-truncates an oversized plain-text payload with the in-band sentinel', () => {
		const value = toolContent('result', 'plain text '.repeat(20_000), undefined, 4_096);
		expect(value).toContain('[flue:truncated');
	});

	it('truncates a wide JSON-string payload without an object-tree scan (performance guard)', () => {
		// A parse-then-truncate path would walk the whole object tree per leaf
		// shrink; the raw-string path is a single binary-searched prefix cut.
		const wide = JSON.stringify({
			leaves: Array.from({ length: 2_000 }, () => 'x'.repeat(1_024)),
		});
		expect(wide.length).toBeGreaterThan(2_000_000);
		const started = performance.now();
		const value = toolContent('result', wide, undefined, 4_096);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(250);
		expect(value).toContain('[flue:truncated');
	});

	it('preserves a post-transform string byte-for-byte (no parse of transformed values)', () => {
		const text = toolContent('result', 'ignored', {
			transform: () => '{ "from": "transform" }',
		});
		expect(text).toBe('{ "from": "transform" }');
		const object = toolContent('result', 'ignored', {
			transform: () => ({ from: 'transform' }),
		});
		expect(object).toBe('{"from":"transform"}');
	});

	it('omits the attribute when the transform returns undefined', () => {
		expect(
			toolContent(
				'result',
				{ secret: 'value' },
				{
					transform: () => undefined,
				},
			),
		).toBeUndefined();
	});

	it('emits the transform-failure sentinel instead of leaking unredacted content', () => {
		expect(
			toolContent(
				'result',
				{ secret: 'value' },
				{
					transform: () => {
						throw new Error('boom');
					},
				},
			),
		).toBe('[flue] content transform failed; content omitted');
	});

	it('keeps the deprecated objectShaped field truthful for compatibility', () => {
		// Backends no longer consult it, but the field stays on the result type
		// with its prior semantics: it reports the post-transform value's shape,
		// so a serialized-object string still reports `false`.
		const object = drawContentAttribute(createContentLedger(), undefined, () => ({ a: 1 }), event, {
			key: 'gen_ai.tool.call.result',
			contentType: 'tool_result',
			rawString: true,
		});
		expect(object.objectShaped).toBe(true);
		const text = drawContentAttribute(createContentLedger(), undefined, () => 'plain text', event, {
			key: 'gen_ai.tool.call.result',
			contentType: 'tool_result',
			rawString: true,
		});
		expect(text.objectShaped).toBe(false);
		const serialized = drawContentAttribute(
			createContentLedger(),
			undefined,
			() => '{"a":1}',
			event,
			{ key: 'gen_ai.tool.call.result', contentType: 'tool_result', rawString: true },
		);
		expect(serialized.objectShaped).toBe(false);
	});
});
