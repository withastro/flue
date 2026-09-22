import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createOpenTelemetryInstrumentation } from './index.ts';

const ctx: FlueEventContext = {
	id: 'test-instance',
	agentName: 'ExampleAgent',
	env: {},
	req: undefined,
	log: { info() {}, warn() {}, error() {} },
};

function firstSpan(exporter: InMemorySpanExporter): ReadableSpan {
	const spans = exporter.getFinishedSpans();
	expect(spans).toHaveLength(1);
	const span = spans[0];
	if (!span) throw new Error('expected one finished span');
	return span;
}

/**
 * Run one model-originated tool call through the adapter — `tool_start`
 * (arguments) then `tool` (result) — and return the finished `execute_tool`
 * span. Both events share every identity field, so the adapter's registry
 * matches them onto one span.
 */
function roundTrip(args: unknown, result: unknown): ReadableSpan {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const instrumentation = createOpenTelemetryInstrumentation({
		tracer: provider.getTracer('test'),
	});
	const identity = {
		v: 3 as const,
		eventIndex: 0,
		timestamp: new Date().toISOString(),
		instanceId: 'test-instance',
		harness: 'default',
		conversationId: 'test-conversation',
		session: 'default',
		operationId: 'test-operation',
		turnId: 'test-turn',
		toolCallId: 'call_1',
		toolName: 'lookup',
		origin: 'model' as const,
		agentName: 'ExampleAgent',
		description: 'Look things up',
	};
	instrumentation.observe({ ...identity, type: 'tool_start', args } as FlueObservation, ctx);
	instrumentation.observe(
		{ ...identity, type: 'tool', isError: false, result, durationMs: 5 } as FlueObservation,
		ctx,
	);
	instrumentation.dispose();
	return firstSpan(exporter);
}

describe('OpenTelemetry tool payload attributes', () => {
	it('records a plain object argument and result on the semconv keys', () => {
		const span = roundTrip(
			{ location: 'San Francisco?', date: '2025-10-01' },
			{ conditions: 'sunny', high: 75 },
		);
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe(
			'{"location":"San Francisco?","date":"2025-10-01"}',
		);
		expect(span.attributes['gen_ai.tool.call.result']).toBe('{"conditions":"sunny","high":75}');
		expect(span.attributes['flue.tool.call.arguments']).toBeUndefined();
		expect(span.attributes['flue.tool.call.result']).toBeUndefined();
	});

	it('records a JSON-string payload byte-for-byte on the semconv key', () => {
		const span = roundTrip(JSON.stringify({ a: 1 }), '{ "b": 2 }');
		// Post-transform strings record exactly as returned — the key-routing
		// fix does not deserialize them.
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{"a":1}');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('{ "b": 2 }');
	});

	it('records a JSON-array string payload byte-for-byte on the semconv key', () => {
		const span = roundTrip('[1, 2, 3]', '["a", "b"]');
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('[1, 2, 3]');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('["a", "b"]');
	});

	it('records ordinary text as a raw string on the semconv key', () => {
		const span = roundTrip('how many sunny days?', 'It is sunny with a high of 75.');
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('how many sunny days?');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('It is sunny with a high of 75.');
	});

	it('records arrays and scalars on the semconv keys', () => {
		const span = roundTrip([1, 'two', true], 42);
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('[1,"two",true]');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('42');
	});

	it('records null payloads on the semconv keys', () => {
		const span = roundTrip(null, null);
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('null');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('null');
	});

	it('records the unserializable sentinel on the semconv key', () => {
		const span = roundTrip({}, { value: 1n });
		expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{}');
		expect(span.attributes['gen_ai.tool.call.result']).toBe('[flue] content unserializable');
	});

	it('does not record tool payload content under content: false', () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: provider.getTracer('test'),
			content: false,
		});
		const identity = {
			v: 3 as const,
			eventIndex: 0,
			timestamp: new Date().toISOString(),
			instanceId: 'test-instance',
			harness: 'default',
			conversationId: 'test-conversation',
			session: 'default',
			operationId: 'test-operation',
			turnId: 'test-turn',
			toolCallId: 'call_1',
			toolName: 'lookup',
			origin: 'model' as const,
			agentName: 'ExampleAgent',
			description: 'Look things up',
		};
		instrumentation.observe(
			{ ...identity, type: 'tool_start', args: { a: 1 } } as FlueObservation,
			ctx,
		);
		instrumentation.observe(
			{
				...identity,
				type: 'tool',
				isError: false,
				result: 'text',
				durationMs: 5,
			} as FlueObservation,
			ctx,
		);
		instrumentation.dispose();
		const span = firstSpan(exporter);
		expect(span.attributes['gen_ai.tool.call.arguments']).toBeUndefined();
		expect(span.attributes['gen_ai.tool.call.result']).toBeUndefined();
	});
});
